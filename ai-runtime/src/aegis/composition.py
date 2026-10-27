"""The composition root is the only place selecting concrete infrastructure."""

import os
from collections import OrderedDict
from dataclasses import replace
from pathlib import Path
from threading import Event, Lock
from typing import Any

from .adapters import (
    FaultInjectedInference,
    MemoryContextRepository,
    MemoryNotificationGateway,
    MockInference,
    PlacementScheduler,
    RecentContextRetriever,
    RuleBasedPolicyEngine,
    SimulationNotificationGateway,
    SQLiteContextRepository,
    StructuredTelemetry,
    SyntheticResourceMonitor,
    SystemClock,
    configured_models,
)
from .application import Runtime
from .domain import Backend, ExecutionTrace, ModelCapabilities, WorkloadConstraints
from .ports import ContextRepository, InferenceProvider
from .scenarios import SCENARIOS, make_task


class RuntimeService:
    def __init__(self, detect_models: bool = False, persistence: Path | None = None) -> None:
        self.repository: ContextRepository = (
            SQLiteContextRepository(persistence) if persistence else MemoryContextRepository()
        )
        self.telemetry = StructuredTelemetry()
        self.local, self.cloud = configured_models() if detect_models else (None, None)
        self.clock = SystemClock()
        self.engines: dict[tuple[str, str, str], Runtime] = {}
        self.execution_lock = Lock()
        self.completed: OrderedDict[str, tuple[str, ExecutionTrace]] = OrderedDict()

    def capabilities(self) -> dict[str, Any]:
        return {
            "mock": True,
            "local": bool(self.local and self.local.capabilities.available),
            "cloud": self.cloud is not None,
            "hardware": "Synthetic resource monitor; GPU/NPU metrics unavailable",
            "local_model": self.local.model if self.local else None,
            "cloud_enabled": self.cloud is not None,
        }

    def execute(
        self,
        scenario_id: str,
        event_id: str,
        provider: str = "mock",
        failure: str = "none",
        transport: str = "simulation",
        overrides: dict[str, Any] | None = None,
        allow_remote: bool = False,
        cancel: Event | None = None,
    ) -> dict[str, Any]:
        if scenario_id not in SCENARIOS or provider not in {"mock", "auto", "local", "cloud"}:
            raise ValueError("Unsupported scenario or provider")
        failure = SCENARIOS[scenario_id].get("failure", "none") if failure == "scenario" else failure
        key = (provider, failure, transport)
        if key not in self.engines:
            if len(self.engines) >= 32:
                raise ValueError("Runtime configuration limit reached")
            primary = MockInference(failure)
            providers: list[InferenceProvider] = [primary]
            if provider in {"auto", "local"} and self.local:
                providers.append(self.local)
            if provider in {"auto", "cloud"} and self.cloud:
                providers.append(self.cloud)
            if failure in {"timeout", "invalid_output"}:
                providers = [FaultInjectedInference(item, failure) for item in providers]
            gateway = (
                SimulationNotificationGateway(failure == "delivery")
                if transport == "simulation"
                else MemoryNotificationGateway(failure == "delivery")
            )
            self.engines[key] = Runtime(
                self.repository,
                RecentContextRetriever(),
                RuleBasedPolicyEngine(),
                PlacementScheduler(),
                tuple(providers),
                MockInference(provider_id="safe-mock-fallback"),
                gateway,
                self.telemetry,
                self.clock,
                SyntheticResourceMonitor(),
            )
            self.engines[key].completed = self.completed
            self.engines[key].lock = self.execution_lock
        task = make_task(scenario_id, event_id, overrides)
        constraints = WorkloadConstraints(sensitivity=task.sensitivity, allow_remote=allow_remote)
        return (
            self.engines[key].execute(task, scenario_id, constraints, cancel, failure == "cancel").to_dict()
        )


def lab_candidates(
    local_available: bool = True, local_reasoning: bool = False, cloud_available: bool = True
) -> tuple[ModelCapabilities, ...]:
    basic = frozenset({"classification", "structured_output"})
    return (
        ModelCapabilities(
            "local-candidate",
            Backend.LOCAL,
            local_available,
            basic | ({"reasoning"} if local_reasoning else set()),
            4,
            1200,
        ),
        ModelCapabilities("cloud-candidate", Backend.CLOUD, cloud_available, basic | {"reasoning"}, 0, 1600),
    )


def lab_constraints(
    privacy: str, latency: int, complexity: str, preferred_backend: str = "local"
) -> WorkloadConstraints:
    return replace(
        WorkloadConstraints(
            sensitivity="sensitive" if privacy != "public" else "public",
            allow_remote=privacy in {"public", "remote_permitted"},
            latency_target_ms=latency,
            complexity=complexity,
            preferred_backend=preferred_backend,
        ),
        required_capabilities=frozenset(
            {"classification", "structured_output"} | ({"reasoning"} if complexity == "complex" else set())
        ),
    )


def configured_service() -> RuntimeService:
    path = os.environ.get("AEGIS_CONTEXT_DB")
    return RuntimeService(detect_models=True, persistence=Path(path) if path else None)
