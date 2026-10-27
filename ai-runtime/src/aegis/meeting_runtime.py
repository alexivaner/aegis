"""Composition, bounded meeting workflow and a process-local cooperative work service."""

import re
import time
from dataclasses import asdict
from threading import RLock
from typing import Any
from uuid import uuid4

from .adapters import CloudInference, OllamaInference, PlacementScheduler, RuleBasedPolicyEngine, SystemClock
from .domain import Backend, DeviceContext, WorkloadConstraints
from .meeting_adapters import ExtractiveMeetingBackend, ModelMeetingBackend
from .meeting_domain import CooperativeQueue, parse_notes, validate_document
from .ports import MeetingInferenceProvider

SAMPLES = [
    {
        "id": "design",
        "title": "Design review",
        "notes": "Maya: I'll send the design draft by Friday.\nRafi: I'll review the draft by Monday.\nTeam: We agreed to postpone the launch until the review is complete.\nMaya: The first pilot will include five volunteers.",
    },
    {
        "id": "week",
        "title": "Weekly planning",
        "notes": "Noor: I'll update the project brief by Tuesday.\nLina: I'll check the budget by Thursday.\nTeam: We decided to keep the first release small.\nNoor: The release will include search and a reading list.",
    },
    {
        "id": "uncertain",
        "title": "Missing deadline",
        "notes": "Ari: I'll prepare the comparison.\nJo: We should explore a second design before deciding.\nTeam: We agreed to keep both options open.\nAri: The comparison needs feedback from two reviewers.",
    },
]
EXPERIMENTS = [
    {
        "id": "baseline",
        "title": "1. Follow the evidence",
        "goal": "Run the notes, then select an action to highlight its source.",
        "options": {},
    },
    {
        "id": "cloud",
        "title": "2. Permit the cloud",
        "goal": "Disable the local candidate and permit cloud processing. Observe the permitted route.",
        "options": {"private": False, "local_available": False},
    },
    {
        "id": "offline",
        "title": "3. Work offline",
        "goal": "The network is unavailable. See why the local candidate can still be selected.",
        "options": {"network": "offline"},
    },
    {
        "id": "blocked",
        "title": "4. Protect private notes",
        "goal": "No local candidate is available. Private notes must not escape to the cloud; execution is blocked.",
        "options": {"private": True, "local_available": False},
    },
    {
        "id": "busy",
        "title": "5. Give the meeting priority",
        "goal": "Start background indexing, then request a summary. Inspect the queue's decision.",
        "options": {"busy": True},
    },
    {
        "id": "fallback",
        "title": "6. Recover from failure",
        "goal": "The first candidate times out. A cloud fallback is possible only with explicit permission.",
        "options": {"private": False, "failure": "timeout"},
    },
]
DEFAULTS: dict[str, Any] = {
    "mode": "learning",
    "private": True,
    "network": "online",
    "local_available": True,
    "cloud_available": True,
    "busy": False,
    "failure": "none",
}
BACKGROUND = [
    "Design notes describe a small pilot and a reading list.",
    "Search helps readers find relevant reference material.",
    "Weekly reviews record decisions and next steps.",
    "Reference notes are fictional and stay in this learning workspace.",
]


class MeetingService:
    def __init__(self, local: OllamaInference | None = None, cloud: CloudInference | None = None) -> None:
        self.local, self.cloud = local, cloud
        self.clock = SystemClock()
        self.policy, self.scheduler = RuleBasedPolicyEngine(), PlacementScheduler()
        self.sessions: dict[str, tuple[CooperativeQueue, float]] = {}
        self.lock = RLock()

    def capabilities(self) -> dict[str, Any]:
        return {
            "local": bool(self.local and self.local.capabilities.available),
            "cloud": self.cloud is not None,
            "local_model": self.local.model if self.local else None,
            "learning": True,
        }

    def providers(self, values: dict[str, Any]) -> tuple[MeetingInferenceProvider, ...]:
        if values["mode"] == "learning":
            return (
                ExtractiveMeetingBackend(Backend.LOCAL, values["local_available"]),
                ExtractiveMeetingBackend(Backend.CLOUD, values["cloud_available"]),
            )
        providers: list[MeetingInferenceProvider] = []
        if values["local_available"] and self.local and self.local.capabilities.available:
            providers.append(ModelMeetingBackend(self.local))
        if values["cloud_available"] and self.cloud:
            providers.append(ModelMeetingBackend(self.cloud))
        return tuple(providers)

    def plan(self, options: dict[str, Any]) -> dict[str, Any]:
        values = {**DEFAULTS, **options}
        candidates = tuple(provider.capabilities for provider in self.providers(values))
        device = DeviceContext(
            cpu=85 if values["busy"] else 30,
            available_memory_gb=6 if values["busy"] else 8,
            network=values["network"],
        )
        constraints = WorkloadConstraints(
            sensitivity="sensitive" if values["private"] else "public",
            allow_remote=not values["private"],
            latency_target_ms=5000,
            required_capabilities=frozenset({"summarization", "structured_output"}),
        )
        admission = self.policy.evaluate(device, constraints, candidates)
        placement = self.scheduler.select(admission, constraints, candidates)
        return {
            "telemetry": asdict(device),
            "policy": admission.to_dict(),
            "placement": asdict(placement),
            "mode": values["mode"],
            "provenance": "Hypothetical resource/model profiles"
            if values["mode"] == "learning"
            else "Configured models with synthetic resource inputs; capabilities/latency estimates need calibration",
            "privacy": "On-device only" if values["private"] else "Cloud processing explicitly permitted",
        }

    def execute(
        self, notes: str, options: dict[str, Any], queue_reason: str = "Interactive meeting request selected"
    ) -> dict[str, Any]:
        values = {**DEFAULTS, **options}
        start = self.clock.monotonic()
        sentences = parse_notes(notes)
        plan = self.plan(values)
        trace: list[dict[str, Any]] = []

        def step(key: str, title: str, meaning: str, data: object, tick: float | None = None) -> None:
            trace.append(
                {
                    "id": key,
                    "title": title,
                    "explanation": meaning,
                    "data": data,
                    "duration_ms": round((self.clock.monotonic() - tick) * 1000, 4)
                    if tick is not None
                    else None,
                }
            )

        step(
            "read",
            "Read the notes",
            f"Accepted {len(sentences)} numbered contributions. These are the evidence for the output.",
            {"source_count": len(sentences)},
        )
        step(
            "telemetry",
            "Observe the conditions",
            "Read the supplied device/network conditions. These inputs are simulated, not readings from your laptop.",
            plan["telemetry"],
        )
        step(
            "policy",
            "Check what is allowed",
            "Privacy is checked before placement. Only admitted candidates can receive the notes.",
            plan["policy"],
        )
        step(
            "scheduler",
            "Choose where and when",
            queue_reason + ". " + plan["placement"]["rationale"],
            plan["placement"],
        )
        result: dict[str, Any] = {
            "trace_id": str(uuid4()),
            "state": "blocked",
            "sentences": [asdict(item) for item in sentences],
            "options": values,
            "plan": plan,
            "document": None,
            "trace": trace,
            "actual_backend": None,
            "execution_kind": "not_executed",
            "error": None,
            "attempts": [],
            "elapsed_ms": 0,
            "note": "No email, task-system update, or notification is sent. This output is for review.",
        }
        selected = plan["placement"]["selected"]
        if selected is None:
            result["error"] = "No permitted backend. Change availability or wait; privacy is not bypassed."
        else:
            eligible_ids = [selected, *plan["placement"]["alternatives"]]
            providers = {provider.capabilities.provider_id: provider for provider in self.providers(values)}
            for provider_id in eligible_ids:
                provider = providers[provider_id]
                for attempt in range(2):
                    tick = self.clock.monotonic()
                    try:
                        if provider_id == selected and values["failure"] == "timeout":
                            raise TimeoutError("Injected timeout; the provider was not called")
                        if provider_id == selected and values["failure"] == "invalid_output":
                            raw = {
                                "summary": [
                                    {"text": "Invented", "source_ids": ["s999"], "evidence_quote": "Invented"}
                                ],
                                "actions": [],
                                "decisions": [],
                            }
                        else:
                            raw = provider.summarize(sentences, timeout=8)
                        document = validate_document(raw, sentences)
                        result["attempts"].append(
                            {
                                "provider": provider_id,
                                "attempt": attempt + 1,
                                "status": "accepted",
                                "duration_ms": round((self.clock.monotonic() - tick) * 1000, 4),
                            }
                        )
                        result.update(
                            state="complete",
                            document=document,
                            actual_backend=provider_id,
                            execution_kind="extractive_learning_rules"
                            if values["mode"] == "learning"
                            else "actual_local_model"
                            if provider.capabilities.backend == Backend.LOCAL
                            else "actual_cloud_model",
                        )
                        step(
                            "execution",
                            "Produce the draft",
                            "Text rules extracted source passages and explicit commitments; no AI model or cloud request was used."
                            if values["mode"] == "learning"
                            else "A configured model returned a structured draft. Review it against the cited sources.",
                            {
                                "actual_backend": provider_id,
                                "execution_kind": result["execution_kind"],
                                "attempts": result["attempts"],
                            },
                            tick,
                        )
                        step(
                            "validation",
                            "Verify source references",
                            "Checked output structure, source IDs and exact evidence quotes. Owners/deadlines must appear in the sources. These checks do not prove every AI paraphrase is correct.",
                            {
                                "key_points": len(document["summary"]),
                                "actions": len(document["actions"]),
                                "decisions": len(document["decisions"]),
                            },
                        )
                        break
                    except (TimeoutError, ConnectionError, ValueError, KeyError, TypeError) as error:
                        category = (
                            "timeout"
                            if isinstance(error, TimeoutError)
                            else "provider_unavailable"
                            if isinstance(error, ConnectionError)
                            else "invalid_evidence_or_schema"
                        )
                        result["attempts"].append(
                            {
                                "provider": provider_id,
                                "attempt": attempt + 1,
                                "status": category,
                                "duration_ms": round((self.clock.monotonic() - tick) * 1000, 4),
                            }
                        )
                        if category == "invalid_evidence_or_schema" or attempt == 1:
                            break
                        self.clock.sleep(0.02)
                if result["state"] == "complete":
                    break
            if result["state"] != "complete":
                result["state"], result["error"] = (
                    "failed",
                    "Permitted providers could not produce a valid result. Nothing was fabricated.",
                )
                step(
                    "execution",
                    "Execution did not complete",
                    result["error"],
                    {"attempts": result["attempts"]},
                )
        result["elapsed_ms"] = round((self.clock.monotonic() - start) * 1000, 4)
        step(
            "outcomes",
            "Record the outcome",
            "Measured Python execution time and retained this run in the bounded workspace. No hardware energy, GPU or NPU metric is claimed.",
            {
                "elapsed_ms": result["elapsed_ms"],
                "state": result["state"],
                "sensitive_prompts_in_trace": False,
            },
        )
        return result

    def create_session(self) -> str:
        with self.lock:
            now = time.monotonic()
            self.sessions = {key: value for key, value in self.sessions.items() if now - value[1] < 1800}
            if len(self.sessions) >= 16:
                oldest = min(self.sessions, key=lambda key: self.sessions[key][1])
                del self.sessions[oldest]
            key = str(uuid4())
            self.sessions[key] = (CooperativeQueue(), now)
            return key

    def queue(self, session_id: str) -> CooperativeQueue:
        if session_id in self.sessions and time.monotonic() - self.sessions[session_id][1] >= 1800:
            del self.sessions[session_id]
        if session_id not in self.sessions:
            raise ValueError("Workspace expired; reload this page")
        queue, _ = self.sessions[session_id]
        self.sessions[session_id] = (queue, time.monotonic())
        return queue

    def enqueue(
        self, session_id: str, kind: str, notes: str = "", options: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        with self.lock:
            if kind == "meeting":
                parse_notes(notes)
            queue = self.queue(session_id)
            item = queue.add(
                kind,
                "Summarize this meeting" if kind == "meeting" else "Organize reference notes",
                {"notes": notes, "options": options or {}},
            )
            return {"job_id": item.id, "queue": queue.snapshot()}

    def advance(self, session_id: str) -> dict[str, Any]:
        with self.lock:
            queue = self.queue(session_id)
            item = queue.next()
            result = None
            if item:
                if item.kind == "background":
                    queue.words.update(re.findall(r"[a-z]+", BACKGROUND[item.done].lower()))
                    item.done += 1
                    item.status = "complete" if item.done == item.total else "paused"
                    queue.log(
                        f"Indexed reference chunk {item.done}/{item.total}; {len(queue.words)} distinct words indexed."
                    )
                else:
                    result = self.execute(
                        item.payload["notes"],
                        item.payload["options"],
                        "The queue selected this interactive meeting request for its next work turn",
                    )
                    item.result, item.done = result, 1
                    item.status = result["state"]
                    queue.log("Meeting request finished: " + result["state"] + ".")
                    # Release draft notes from the job payload; result keeps evidence for review.
                    item.payload = {}
            return {"job_id": item.id if item else None, "result": result, "queue": queue.snapshot()}

    def cancel(self, session_id: str, job_id: str) -> dict[str, Any]:
        with self.lock:
            queue = self.queue(session_id)
            item = next((item for item in queue.items if item.id == job_id), None)
            if item and item.status in {"queued", "paused"}:
                item.status, item.payload = "cancelled", {}
                queue.log(f"Cancelled {item.label} before its next work turn.")
            return queue.snapshot()
