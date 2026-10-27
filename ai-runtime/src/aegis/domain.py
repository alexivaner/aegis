"""Framework-free value objects, validation, routing, and notification policy."""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any


class Backend(StrEnum):
    LOCAL = "local"
    CLOUD = "cloud"
    MOCK = "mock"


class State(StrEnum):
    NEW = "new"
    INGESTED = "event_ingestion"
    CONTEXT = "context_assembly"
    RETRIEVED = "context_retrieval"
    PLANNED = "agent_planning"
    ROUTED = "backend_selection"
    INFERRED = "model_execution"
    VALIDATED = "output_validation"
    POLICY = "policy_enforcement"
    DISPATCHED = "notification_dispatch"
    RECORDED = "telemetry_recording"
    FAILED = "failed"
    CANCELLED = "cancelled"
    DUPLICATE = "duplicate"


STAGES = tuple(State)[1:11]
TERMINAL = {State.RECORDED, State.FAILED, State.CANCELLED, State.DUPLICATE}


def transition(current: State, target: State) -> State:
    if current in TERMINAL:
        raise ValueError("Cannot leave a terminal workflow state")
    if target in {State.FAILED, State.CANCELLED, State.DUPLICATE}:
        return target
    sequence = (State.NEW, *STAGES)
    if sequence.index(target) != sequence.index(current) + 1:
        raise ValueError(f"Invalid transition: {current} -> {target}")
    return target


@dataclass(frozen=True)
class DeviceContext:
    battery: int = 65
    cpu: int = 40
    memory_utilization: int = 45
    available_memory_gb: float = 8
    network: str = "online"
    meeting_minutes: int | None = None
    focus_mode: bool = False

    def __post_init__(self) -> None:
        for value in (self.battery, self.cpu, self.memory_utilization):
            if type(value) is not int or not 0 <= value <= 100:
                raise ValueError("Resource percentages must be integers in [0, 100]")
        if not math.isfinite(self.available_memory_gb) or not 0 <= self.available_memory_gb <= 256:
            raise ValueError("Available memory must be finite and in [0, 256] GB")
        if self.network not in {"online", "unstable", "offline"}:
            raise ValueError("Unknown network state")
        if self.meeting_minutes is not None and not 0 <= self.meeting_minutes <= 1440:
            raise ValueError("Invalid meeting offset")


@dataclass(frozen=True)
class AgentTask:
    task_id: str
    event_id: str
    kind: str
    severity: str
    device: DeviceContext
    sensitivity: str = "public"


@dataclass(frozen=True)
class WorkloadConstraints:
    sensitivity: str = "public"
    allow_remote: bool = False
    latency_target_ms: int = 1800
    complexity: str = "light"
    required_capabilities: frozenset[str] = frozenset({"classification", "structured_output"})
    preferred_backend: str = "local"

    def __post_init__(self) -> None:
        if self.sensitivity not in {"public", "sensitive"} or self.complexity not in {"light", "complex"}:
            raise ValueError("Invalid workload constraint")
        if not 50 <= self.latency_target_ms <= 30000:
            raise ValueError("Latency target must be in [50, 30000] ms")
        if self.preferred_backend not in {"local", "cloud"}:
            raise ValueError("Preferred backend must be local or cloud")


@dataclass(frozen=True)
class ModelCapabilities:
    provider_id: str
    backend: Backend
    available: bool
    capabilities: frozenset[str]
    minimum_memory_gb: float = 0
    estimated_latency_ms: int = 0


@dataclass(frozen=True)
class RoutingDecision:
    selected: str | None
    backend: str | None
    rationale: str
    alternatives: tuple[str, ...]
    rejected: dict[str, tuple[str, ...]]
    estimates_only: bool = True
    policy_evaluation: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyEvaluation:
    """Admission facts only. Policy does not choose or execute a backend."""

    eligible: tuple[str, ...]
    rejected: dict[str, tuple[str, ...]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "eligible": self.eligible,
            "rejected": self.rejected,
            "order": "privacy and permission, then availability/capability/resource/latency feasibility",
            "resource_provenance": "Synthetic snapshot and estimated model profiles; not hardware measurements",
        }


def evaluate_workload_policy(
    device: DeviceContext, constraints: WorkloadConstraints, candidates: tuple[ModelCapabilities, ...]
) -> PolicyEvaluation:
    """Determine permitted candidates; never select a preferred execution backend."""
    rejected: dict[str, tuple[str, ...]] = {}
    eligible: list[str] = []
    for candidate in candidates:
        reasons: list[str] = []
        if candidate.backend == Backend.CLOUD and not constraints.allow_remote:
            reasons.append("Remote processing is not permitted")
        if not candidate.available:
            reasons.append("Backend is unavailable")
        required = constraints.required_capabilities | (
            {"reasoning"} if constraints.complexity == "complex" else set()
        )
        if not required <= candidate.capabilities:
            reasons.append("Missing required capabilities")
        if candidate.backend == Backend.CLOUD:
            if device.network == "offline":
                reasons.append("Network is unavailable")
            if device.network == "unstable" and constraints.latency_target_ms < 2000:
                reasons.append("Unstable network cannot meet this conservative latency budget")
        if candidate.backend == Backend.LOCAL:
            if device.available_memory_gb < candidate.minimum_memory_gb:
                reasons.append("Insufficient available memory")
            if device.battery < 10:
                reasons.append("Battery reserve is below the local inference threshold")
            if device.cpu >= 95:
                reasons.append("CPU budget is exhausted")
        if (
            candidate.backend != Backend.MOCK
            and candidate.estimated_latency_ms > constraints.latency_target_ms
        ):
            reasons.append("Estimated latency exceeds the target")
        if reasons:
            rejected[candidate.provider_id] = tuple(reasons)
        else:
            eligible.append(candidate.provider_id)
    return PolicyEvaluation(tuple(eligible), rejected)


def select_backend(
    evaluation: PolicyEvaluation, constraints: WorkloadConstraints, candidates: tuple[ModelCapabilities, ...]
) -> RoutingDecision:
    """Single-workload placement among policy-admitted candidates. No queue or optimizer."""
    eligible = [
        item
        for item in candidates
        if item.provider_id in evaluation.eligible and item.provider_id not in evaluation.rejected
    ]
    rejected = evaluation.rejected
    eligible.sort(
        key=lambda item: (
            2 if item.backend == Backend.MOCK else 0 if item.backend == constraints.preferred_backend else 1
        )
    )
    if not eligible:
        return RoutingDecision(
            None,
            None,
            "No backend satisfies privacy, capability, and resource constraints.",
            (),
            rejected,
            policy_evaluation=evaluation.to_dict(),
        )
    chosen = eligible[0]
    rationale = {
        Backend.LOCAL: "Local inference is feasible; keeping context on-device avoids remote processing.",
        Backend.CLOUD: "Cloud is permitted and feasible; the local option is not eligible.",
        Backend.MOCK: "Use deterministic mock inference: no eligible configured model backend is available.",
    }[chosen.backend]
    if constraints.sensitivity == "sensitive" and chosen.backend == Backend.LOCAL:
        rationale = "Sensitive context stays local; the model satisfies the required capabilities and resource budget."
    if chosen.backend == Backend.CLOUD and any(item.backend == Backend.LOCAL for item in eligible):
        rationale = "Both routes are eligible; the scheduler follows the cloud-first preference."
    return RoutingDecision(
        chosen.provider_id,
        chosen.backend.value,
        rationale,
        tuple(item.provider_id for item in eligible[1:]),
        rejected,
        policy_evaluation=evaluation.to_dict(),
    )


def route_workload(
    device: DeviceContext, constraints: WorkloadConstraints, candidates: tuple[ModelCapabilities, ...]
) -> RoutingDecision:
    """Convenience composition; live orchestration injects the two boundaries separately."""
    return select_backend(evaluate_workload_policy(device, constraints, candidates), constraints, candidates)


@dataclass(frozen=True)
class InferenceRequest:
    task: AgentTask
    preferences: dict[str, bool]
    recent_context: tuple[dict[str, str], ...]
    constraints: WorkloadConstraints


@dataclass(frozen=True)
class InferenceResult:
    raw: dict[str, Any]
    provider_id: str
    execution_kind: str
    token_count: int | None = None


@dataclass(frozen=True)
class NotificationIntent:
    priority: str
    summary: str
    reasoning_summary: str
    proposed_action: str
    recommended_channel: str
    confidence: float
    required_capabilities: tuple[str, ...]

    @classmethod
    def validate(cls, raw: dict[str, Any]) -> NotificationIntent:
        keys = {
            "priority",
            "summary",
            "reasoning_summary",
            "proposed_action",
            "recommended_channel",
            "confidence",
            "required_capabilities",
        }
        if set(raw) != keys:
            raise ValueError("Model response does not match the allowed schema")
        if raw["priority"] not in {"low", "normal", "high", "critical"}:
            raise ValueError("Invalid priority")
        if raw["proposed_action"] not in {"notify", "defer", "suppress"}:
            raise ValueError("Unsupported action")
        if raw["recommended_channel"] not in {"desktop", "in_app"}:
            raise ValueError("Unsupported channel")
        for name, limit in (("summary", 240), ("reasoning_summary", 600)):
            if not isinstance(raw[name], str) or not 1 <= len(raw[name]) <= limit:
                raise ValueError(f"Invalid {name}")
        confidence = raw["confidence"]
        if type(confidence) not in {float, int} or not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise ValueError("Invalid confidence")
        caps = raw["required_capabilities"]
        if not isinstance(caps, list) or not all(isinstance(item, str) for item in caps) or len(caps) > 8:
            raise ValueError("Invalid capabilities")
        return cls(
            raw["priority"],
            raw["summary"],
            raw["reasoning_summary"],
            raw["proposed_action"],
            raw["recommended_channel"],
            float(confidence),
            tuple(caps),
        )


@dataclass(frozen=True)
class NotificationDecision:
    event_id: str
    action: str
    channel: str
    summary: str
    reasons: tuple[str, ...]


def notification_policy(
    task: AgentTask, intent: NotificationIntent, preferences: dict[str, bool]
) -> NotificationDecision:
    reasons: list[str] = []
    action = intent.proposed_action
    if not set(intent.required_capabilities) <= {"classification", "structured_output", "reasoning"}:
        action = "suppress"
        reasons.append("Model requested a capability outside the tool allowlist")
    elif task.severity == "critical":
        action = "notify"
        reasons.append("The trusted synthetic event is critical; notify immediately")
    elif intent.priority == "critical":
        action = "defer"
        reasons.append("A model cannot promote an ordinary event to a critical action")
    elif intent.confidence < 0.65:
        action = "defer"
        reasons.append("Confidence is below the conservative decision threshold")
    elif task.device.focus_mode and task.severity == "low" and preferences.get("suppress_during_focus", True):
        action = "defer"
        reasons.append("Focus policy defers low-priority events regardless of the proposed action")
    elif (
        task.device.meeting_minutes == 0
        and task.severity == "low"
        and preferences.get("suppress_during_meeting", True)
    ):
        action = "defer"
        reasons.append("Meeting policy defers low-priority events")
    else:
        reasons.append("Validated intent satisfies the deterministic notification policy")
    return NotificationDecision(
        task.event_id, action, intent.recommended_channel, intent.summary, tuple(reasons)
    )


@dataclass
class ExecutionTrace:
    trace_id: str
    task_id: str
    event_id: str
    scenario_id: str
    started_at: str
    state: State = State.NEW
    stages: list[dict[str, Any]] = field(default_factory=list)
    routing: RoutingDecision | None = None
    intent: NotificationIntent | None = None
    decision: NotificationDecision | None = None
    selected_provider: str | None = None
    execution_kind: str = "not_executed"
    latency_ms: float = 0
    token_count: int | None = None
    retry_count: int = 0
    error_category: str | None = None
    delivered: bool = False
    metric_provenance: str = "Measured Python execution over synthetic inputs; not production benchmarks"
    hardware_metrics: None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
