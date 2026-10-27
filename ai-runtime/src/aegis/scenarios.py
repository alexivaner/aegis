"""Public synthetic fixtures, unrelated to any employer or real device."""

from dataclasses import asdict
from typing import Any

from .domain import AgentTask, DeviceContext

SCENARIOS: dict[str, dict[str, Any]] = {
    "battery": {
        "name": "Low battery before a meeting",
        "description": "17% battery, a busy CPU, and a meeting in eight minutes.",
        "severity": "high",
        "device": {
            "battery": 17,
            "cpu": 88,
            "memory_utilization": 76,
            "network": "unstable",
            "meeting_minutes": 8,
        },
        "expected": "notify",
    },
    "cpu": {
        "name": "High CPU during intensive work",
        "description": "Resource pressure without an active focus policy.",
        "severity": "normal",
        "device": {"cpu": 92, "available_memory_gb": 3},
        "expected": "notify",
    },
    "update": {
        "name": "An update arrives during focus mode",
        "description": "A deterministic policy can defer this event without inference.",
        "severity": "low",
        "device": {"focus_mode": True},
        "expected": "defer",
    },
    "network": {
        "name": "Network goes offline",
        "description": "Cloud inference must be rejected when there is no network.",
        "severity": "normal",
        "device": {"network": "offline"},
        "expected": "notify",
    },
    "timeout": {
        "name": "Preferred backend times out",
        "description": "Two bounded attempts, then a clearly identified mock fallback.",
        "severity": "normal",
        "device": {},
        "failure": "timeout",
        "expected": "notify",
    },
    "urgent": {
        "name": "A critical alert needs attention",
        "description": "A trusted critical event takes precedence over focus mode.",
        "severity": "critical",
        "device": {"focus_mode": True, "cpu": 98},
        "expected": "notify",
    },
}


def make_task(scenario_id: str, event_id: str, overrides: dict[str, Any] | None = None) -> AgentTask:
    data = SCENARIOS[scenario_id]
    device = DeviceContext(**{**data["device"], **(overrides or {})})
    return AgentTask(
        "task-" + event_id,
        event_id,
        scenario_id,
        data["severity"],
        device,
        "sensitive" if scenario_id == "battery" else "public",
    )


def catalog() -> list[dict[str, Any]]:
    return [
        {
            "id": key,
            "name": data["name"],
            "description": data["description"],
            "device": asdict(make_task(key, "catalog").device),
            "expected": data["expected"],
        }
        for key, data in SCENARIOS.items()
    ]
