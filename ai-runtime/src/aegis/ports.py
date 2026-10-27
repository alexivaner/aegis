"""Application-owned boundaries; no framework or provider SDK imports."""

from typing import Any, Protocol

from .domain import (
    AgentTask,
    DeviceContext,
    ExecutionTrace,
    InferenceRequest,
    InferenceResult,
    ModelCapabilities,
    NotificationDecision,
    PolicyEvaluation,
    RoutingDecision,
    WorkloadConstraints,
)
from .meeting_domain import Sentence


class InferenceProvider(Protocol):
    capabilities: ModelCapabilities

    def infer(self, request: InferenceRequest, timeout: float) -> InferenceResult: ...


class ContextRepository(Protocol):
    def preferences(self) -> dict[str, bool]: ...
    def recent(self, limit: int) -> tuple[dict[str, str], ...]: ...
    def append(self, task: AgentTask) -> None: ...
    def save_decision(self, decision: NotificationDecision) -> None: ...


class ContextRetriever(Protocol):
    def retrieve(
        self, task: AgentTask, records: tuple[dict[str, str], ...]
    ) -> tuple[dict[str, str], ...]: ...


class PolicyEngine(Protocol):
    def evaluate(
        self,
        device: DeviceContext,
        constraints: WorkloadConstraints,
        candidates: tuple[ModelCapabilities, ...],
    ) -> PolicyEvaluation: ...


class WorkloadScheduler(Protocol):
    def select(
        self,
        evaluation: PolicyEvaluation,
        constraints: WorkloadConstraints,
        candidates: tuple[ModelCapabilities, ...],
    ) -> RoutingDecision: ...


class NotificationGateway(Protocol):
    name: str

    def dispatch(self, decision: NotificationDecision) -> bool: ...


class TelemetrySink(Protocol):
    def record(self, trace: ExecutionTrace) -> None: ...
    def list_traces(self) -> list[dict[str, Any]]: ...


class Clock(Protocol):
    def now(self) -> str: ...
    def monotonic(self) -> float: ...
    def sleep(self, seconds: float) -> None: ...


class ResourceMonitor(Protocol):
    def snapshot(self, task: AgentTask) -> DeviceContext: ...


class MeetingInferenceProvider(Protocol):
    capabilities: ModelCapabilities

    def summarize(self, sentences: tuple[Sentence, ...], timeout: float) -> dict[str, Any]: ...
