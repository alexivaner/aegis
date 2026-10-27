"""Loopback-only FastAPI inbound adapter. All event inputs are synthetic fixtures."""

from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import asdict
from threading import Event, Lock
from typing import Any, Literal
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .adapters import PlacementScheduler, RuleBasedPolicyEngine
from .composition import RuntimeService, configured_service, lab_candidates, lab_constraints
from .domain import DeviceContext
from .meeting_runtime import EXPERIMENTS, SAMPLES, MeetingService
from .scenarios import catalog


class ExecuteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario_id: Literal["battery", "cpu", "update", "network", "timeout", "urgent"] = "battery"
    event_id: str = Field(
        default_factory=lambda: str(uuid4()), min_length=1, max_length=80, pattern=r"^[\w-]+$"
    )
    provider: Literal["mock", "auto", "local", "cloud"] = "mock"
    failure: Literal["none", "scenario", "timeout", "invalid_output", "delivery", "cancel"] = "scenario"
    transport: Literal["simulation", "in_memory"] = "simulation"
    allow_remote: bool = False


class RouteInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    battery: int = Field(default=65, ge=0, le=100)
    memory: float = Field(default=8, ge=0, le=256, allow_inf_nan=False)
    cpu: int = Field(default=40, ge=0, le=100)
    network: Literal["online", "unstable", "offline"] = "online"
    privacy: Literal["local_only", "public", "remote_permitted"] = "local_only"
    latency: int = Field(default=1800, ge=50, le=30000)
    complexity: Literal["light", "complex"] = "light"
    local_available: bool = True
    local_reasoning: bool = False
    cloud_available: bool = True
    preferred_backend: Literal["local", "cloud"] = "local"


class MeetingOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["learning", "model"] = "learning"
    private: bool = True
    network: Literal["online", "offline"] = "online"
    local_available: bool = True
    cloud_available: bool = True
    busy: bool = False
    failure: Literal["none", "timeout", "invalid_output"] = "none"


class MeetingJob(MeetingOptions):
    session_id: str = Field(min_length=36, max_length=36, pattern=r"^[a-f0-9-]+$")
    kind: Literal["meeting", "background"] = "meeting"
    notes: str = Field(default="", max_length=6000)


class MeetingSessionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str = Field(min_length=36, max_length=36, pattern=r"^[a-f0-9-]+$")
    job_id: str | None = Field(default=None, max_length=36)


def create_app(service: RuntimeService | None = None) -> FastAPI:
    runtime = service or configured_service()
    meetings = MeetingService(runtime.local, runtime.cloud)
    app = FastAPI(title="Aegis experimental runtime", version="0.1.0")
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="aegis")
    jobs: dict[str, tuple[Future[dict[str, Any]], Event]] = {}
    lock = Lock()

    @app.get("/api/aegis/health")
    def health() -> dict[str, Any]:
        return {
            "status": "ready",
            "version": "0.1.0",
            "capabilities": runtime.capabilities(),
            "synthetic_only": True,
            "external_notifications": False,
        }

    @app.get("/api/aegis/scenarios")
    def scenarios() -> list[dict[str, Any]]:
        return catalog()

    @app.post("/api/aegis/route")
    def route(data: RouteInput) -> dict[str, Any]:
        device = DeviceContext(
            battery=data.battery, cpu=data.cpu, available_memory_gb=data.memory, network=data.network
        )
        constraints = lab_constraints(data.privacy, data.latency, data.complexity, data.preferred_backend)
        candidates = lab_candidates(data.local_available, data.local_reasoning, data.cloud_available)
        evaluation = RuleBasedPolicyEngine().evaluate(device, constraints, candidates)
        decision = PlacementScheduler().select(evaluation, constraints, candidates)
        return {
            **asdict(decision),
            "provenance": "Real Python policy; synthetic backend availability and resource estimates; no inference executed",
        }

    @app.post("/api/aegis/execute")
    def execute(data: ExecuteInput) -> dict[str, Any]:
        return runtime.execute(**data.model_dump())

    @app.post("/api/aegis/jobs")
    def submit(data: ExecuteInput) -> dict[str, str]:
        with lock:
            # Bound retained jobs; completed traces remain in the telemetry ring buffer.
            for job_id in list(jobs):
                if len(jobs) < 30:
                    break
                if jobs[job_id][0].done():
                    del jobs[job_id]
            if len(jobs) >= 32:
                raise HTTPException(429, "Job capacity reached")
            job_id, cancel = str(uuid4()), Event()
            jobs[job_id] = (executor.submit(runtime.execute, **data.model_dump(), cancel=cancel), cancel)
        return {"job_id": job_id}

    @app.get("/api/aegis/jobs/{job_id}")
    def job(job_id: str) -> dict[str, Any]:
        if job_id not in jobs:
            raise HTTPException(404, "Unknown job")
        future, _ = jobs[job_id]
        if not future.done():
            return {"state": "running"}
        try:
            return {"state": "complete", "trace": future.result()}
        except (ValueError, RuntimeError):
            raise HTTPException(400, "Invalid execution configuration") from None

    @app.post("/api/aegis/jobs/{job_id}/cancel")
    def cancel_job(job_id: str) -> dict[str, Any]:
        if job_id not in jobs:
            raise HTTPException(404, "Unknown job")
        future, cancel = jobs[job_id]
        if not future.done():
            cancel.set()
        return {
            "cancel_requested": not future.done(),
            "scope": "cooperative, between bounded stages and provider attempts",
        }

    @app.get("/api/aegis/traces")
    def traces() -> list[dict[str, Any]]:
        return runtime.telemetry.list_traces()

    @app.get("/api/aegis/meeting/health")
    def meeting_health() -> dict[str, Any]:
        return {"capabilities": meetings.capabilities(), "samples": SAMPLES, "experiments": EXPERIMENTS}

    @app.post("/api/aegis/meeting/plan")
    def meeting_plan(data: MeetingOptions) -> dict[str, Any]:
        return meetings.plan(data.model_dump())

    @app.post("/api/aegis/meeting/session")
    def meeting_session() -> dict[str, Any]:
        return {"session_id": meetings.create_session()}

    @app.post("/api/aegis/meeting/enqueue")
    def meeting_enqueue(data: MeetingJob) -> dict[str, Any]:
        try:
            return meetings.enqueue(
                data.session_id,
                data.kind,
                data.notes,
                data.model_dump(exclude={"session_id", "kind", "notes"}),
            )
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    @app.post("/api/aegis/meeting/step")
    def meeting_step(data: MeetingSessionInput) -> dict[str, Any]:
        try:
            return meetings.advance(data.session_id)
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    @app.post("/api/aegis/meeting/cancel")
    def meeting_cancel(data: MeetingSessionInput) -> dict[str, Any]:
        try:
            return meetings.cancel(data.session_id, data.job_id or "")
        except ValueError as error:
            raise HTTPException(400, str(error)) from None

    app.state.runtime = runtime
    return app


app = create_app()
