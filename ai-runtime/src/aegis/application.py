"""Bounded application orchestration. Depends only on domain types and ports."""

from __future__ import annotations

import hashlib
import json
from collections import OrderedDict
from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict
from threading import Event, Lock
from typing import Any, TypeVar
from uuid import uuid4

from .domain import (
    AgentTask,
    DeviceContext,
    ExecutionTrace,
    InferenceRequest,
    InferenceResult,
    NotificationDecision,
    NotificationIntent,
    State,
    WorkloadConstraints,
    notification_policy,
    transition,
)
from .ports import (
    Clock,
    ContextRepository,
    ContextRetriever,
    InferenceProvider,
    NotificationGateway,
    PolicyEngine,
    ResourceMonitor,
    TelemetrySink,
    WorkloadScheduler,
)

T = TypeVar("T")


class ContextTools:
    """A fixed, typed tool surface. There is no arbitrary tool-name dispatch."""

    def __init__(
        self, repository: ContextRepository, retriever: ContextRetriever, monitor: ResourceMonitor
    ) -> None:
        self.repository, self.retriever, self.monitor = repository, retriever, monitor

    def get_device_context(self, task: AgentTask) -> DeviceContext:
        return self.monitor.snapshot(task)

    def get_user_preferences(self) -> dict[str, bool]:
        return self.repository.preferences()

    def retrieve_recent_events(self, task: AgentTask) -> tuple[dict[str, str], ...]:
        return self.retriever.retrieve(task, self.repository.recent(10))

    def propose_notification(self, raw: dict[str, Any]) -> NotificationIntent:
        return NotificationIntent.validate(raw)

    def record_notification_decision(self, decision: NotificationDecision) -> None:
        self.repository.save_decision(decision)


class CancelledExecution(Exception):
    pass


class Runtime:
    def __init__(
        self,
        repository: ContextRepository,
        retriever: ContextRetriever,
        policy_engine: PolicyEngine,
        scheduler: WorkloadScheduler,
        providers: tuple[InferenceProvider, ...],
        fallback: InferenceProvider,
        gateway: NotificationGateway,
        telemetry: TelemetrySink,
        clock: Clock,
        monitor: ResourceMonitor,
    ) -> None:
        self.repository, self.retriever, self.scheduler = repository, retriever, scheduler
        self.policy_engine = policy_engine
        self.providers, self.fallback, self.gateway = providers, fallback, gateway
        self.telemetry, self.clock, self.monitor = telemetry, clock, monitor
        self.tools = ContextTools(repository, retriever, monitor)
        self.completed: OrderedDict[str, tuple[str, ExecutionTrace]] = OrderedDict()
        self.lock = Lock()

    def execute(
        self,
        task: AgentTask,
        scenario_id: str,
        constraints: WorkloadConstraints,
        cancel: Event | None = None,
        cancel_before_dispatch: bool = False,
    ) -> ExecutionTrace:
        # A deliberately bounded single-process reference runtime. This is not a distributed queue.
        with self.lock:
            return self._execute(task, scenario_id, constraints, cancel or Event(), cancel_before_dispatch)

    def _execute(
        self,
        task: AgentTask,
        scenario_id: str,
        constraints: WorkloadConstraints,
        cancel: Event,
        cancel_before_dispatch: bool,
    ) -> ExecutionTrace:
        started = self.clock.monotonic()
        trace = ExecutionTrace(str(uuid4()), task.task_id, task.event_id, scenario_id, self.clock.now())
        fingerprint = hashlib.sha256(json.dumps(asdict(task), sort_keys=True).encode()).hexdigest()
        if task.event_id in self.completed:
            old_fingerprint, old_trace = self.completed[task.event_id]
            if fingerprint != old_fingerprint:
                trace.state, trace.error_category = State.FAILED, "idempotency_conflict"
            else:
                trace.state, trace.decision = State.DUPLICATE, deepcopy(old_trace.decision)
            trace.latency_ms = round((self.clock.monotonic() - started) * 1000, 4)
            trace.stages.append(
                {
                    "name": "event_ingestion",
                    "status": trace.state.value,
                    "duration_ms": trace.latency_ms,
                    "output": {
                        "original_trace_id": old_trace.trace_id,
                        "message": "Event identity was already recorded; nothing was dispatched.",
                    },
                }
            )
            self.telemetry.record(trace)
            return trace

        def stage(state: State, action: Callable[[], T], output: Callable[[T], object]) -> T:
            if cancel.is_set():
                raise CancelledExecution()
            trace.state = transition(trace.state, state)
            tick = self.clock.monotonic()
            entry: dict[str, Any] = {"name": state.value, "status": "running", "duration_ms": 0}
            trace.stages.append(entry)
            try:
                result = action()
                entry.update(status="completed", output=output(result))
                return result
            except Exception:
                entry.update(
                    status="failed", output={"message": "Stage failed; see the classified trace error."}
                )
                raise
            finally:
                entry["duration_ms"] = round((self.clock.monotonic() - tick) * 1000, 4)

        try:
            stage(
                State.INGESTED,
                lambda: task,
                lambda value: {
                    "event_id": value.event_id,
                    "kind": value.kind,
                    "severity": value.severity,
                    "synthetic": True,
                },
            )
            device = stage(State.CONTEXT, lambda: self.tools.get_device_context(task), asdict)
            preferences = self.tools.get_user_preferences()
            context = stage(
                State.RETRIEVED,
                lambda: self.tools.retrieve_recent_events(task),
                lambda value: {"selected": value, "method": "same-kind recent context, at most 3 records"},
            )
            needs_inference = stage(
                State.PLANNED,
                lambda: not (task.kind == "update" and device.focus_mode and task.severity == "low"),
                lambda value: {
                    "needs_inference": value,
                    "max_provider_attempts": 3,
                    "tools": [
                        "get_device_context",
                        "get_user_preferences",
                        "retrieve_recent_events",
                        "propose_notification",
                        "record_notification_decision",
                    ],
                    "plan": "Classify context, validate structure, enforce policy, then deliver.",
                },
            )
            request = InferenceRequest(task, preferences, context, constraints)
            if needs_inference:
                trace.routing = stage(
                    State.ROUTED,
                    lambda: self.scheduler.select(
                        self.policy_engine.evaluate(
                            device, constraints, tuple(p.capabilities for p in self.providers)
                        ),
                        constraints,
                        tuple(p.capabilities for p in self.providers),
                    ),
                    asdict,
                )
                if trace.routing.selected is None:
                    raise LookupError("No eligible inference provider")
                chosen = next(
                    p for p in self.providers if p.capabilities.provider_id == trace.routing.selected
                )

                def infer() -> InferenceResult:
                    for attempt in range(2):
                        if cancel.is_set():
                            raise CancelledExecution()
                        try:
                            result = chosen.infer(request, timeout=2.5)
                            NotificationIntent.validate(result.raw)
                            return result
                        except (TimeoutError, ConnectionError, ValueError, KeyError, TypeError) as error:
                            trace.error_category = (
                                "provider_timeout"
                                if isinstance(error, TimeoutError)
                                else "provider_unavailable"
                                if isinstance(error, ConnectionError)
                                else "invalid_provider_output"
                            )
                            trace.stages[-1].setdefault("attempts", []).append(
                                {
                                    "attempt": attempt + 1,
                                    "provider": chosen.capabilities.provider_id,
                                    "status": "failed",
                                }
                            )
                            if isinstance(error, (ValueError, KeyError, TypeError)):
                                break
                            if attempt == 0:
                                trace.retry_count += 1
                                self.clock.sleep(0.02)
                    if cancel.is_set():
                        raise CancelledExecution()
                    result = self.fallback.infer(request, timeout=0.5)
                    NotificationIntent.validate(result.raw)
                    trace.stages[-1]["fallback"] = {
                        "provider": result.provider_id,
                        "kind": result.execution_kind,
                    }
                    return result

                result = stage(
                    State.INFERRED,
                    infer,
                    lambda value: {
                        "provider": value.provider_id,
                        "execution_kind": value.execution_kind,
                        "token_count": value.token_count,
                        "raw_intent": value.raw,
                    },
                )
                trace.selected_provider, trace.execution_kind = result.provider_id, result.execution_kind
                trace.token_count = result.token_count
            else:
                stage(
                    State.ROUTED,
                    lambda: None,
                    lambda _: {"skipped": True, "reason": "A deterministic focus rule suffices."},
                )
                result = InferenceResult(
                    {
                        "priority": "low",
                        "summary": "Defer the low-priority update until focus mode ends.",
                        "reasoning_summary": "Deterministic fast path: no model was needed.",
                        "proposed_action": "defer",
                        "recommended_channel": "in_app",
                        "confidence": 1.0,
                        "required_capabilities": [],
                    },
                    "deterministic-policy",
                    "deterministic_policy",
                )
                stage(
                    State.INFERRED,
                    lambda: result,
                    lambda _: {"skipped": True, "execution_kind": "deterministic_policy"},
                )
                trace.execution_kind = "deterministic_policy"
            intent = stage(State.VALIDATED, lambda: self.tools.propose_notification(result.raw), asdict)
            trace.intent = intent
            decision = stage(State.POLICY, lambda: notification_policy(task, intent, preferences), asdict)
            trace.decision = decision
            if cancel_before_dispatch:
                cancel.set()
            trace.delivered = stage(
                State.DISPATCHED,
                lambda: self.gateway.dispatch(decision),
                lambda value: {
                    "delivered_to_simulation": value,
                    "gateway": self.gateway.name,
                    "actual_os_notification": False,
                    "action": decision.action,
                },
            )
            stage(
                State.RECORDED,
                lambda: self.tools.record_notification_decision(decision),
                lambda _: {"decision_recorded": True, "sensitive_prompts_logged": False},
            )
        except CancelledExecution:
            trace.state = transition(trace.state, State.CANCELLED)
            trace.error_category = "cancelled_at_stage_boundary"
        except (ConnectionError, TimeoutError):
            failed_state = trace.state
            trace.state = transition(trace.state, State.FAILED)
            trace.error_category = (
                "delivery_failure" if failed_state == State.DISPATCHED else "adapter_unavailable"
            )
        except LookupError:
            trace.state = transition(trace.state, State.FAILED)
            trace.error_category = "no_eligible_backend"
        except (ValueError, KeyError, TypeError):
            trace.state = transition(trace.state, State.FAILED)
            trace.error_category = "invalid_response_or_transition"
        trace.latency_ms = round((self.clock.monotonic() - started) * 1000, 4)
        self.repository.append(task)
        self.telemetry.record(trace)
        if len(self.completed) >= 1000:
            self.completed.popitem(last=False)
        self.completed[task.event_id] = (fingerprint, trace)
        return trace
