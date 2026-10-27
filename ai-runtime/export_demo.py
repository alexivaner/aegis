"""Generate portable fixtures and a truthful evaluation report from executed Python code."""

import json
import statistics
import sys
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from aegis.composition import RuntimeService, lab_candidates, lab_constraints
from aegis.domain import DeviceContext, route_workload
from aegis.meeting_runtime import EXPERIMENTS, SAMPLES, MeetingService
from aegis.scenarios import SCENARIOS, catalog, make_task

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public/aegis-data"
OUT.mkdir(parents=True, exist_ok=True)
traces = {}
evaluation = []
for scenario, fixture in SCENARIOS.items():
    for failure in ("scenario", "none", "timeout", "invalid_output", "delivery", "cancel"):
        for transport in ("simulation", "in_memory"):
            service = RuntimeService()
            service.repository.append(make_task(scenario, "synthetic-history-1"))
            trace = service.execute(
                scenario, f"recorded-{scenario}-{failure}-{transport}", failure=failure, transport=transport
            )
            trace["provenance"] = "recorded_python_mock_execution"
            traces[f"{scenario}:{failure}:{transport}"] = trace
            if failure == "scenario" and transport == "simulation":
                actual = trace["decision"]["action"] if trace["decision"] else None
                evaluation.append(
                    {
                        "scenario": scenario,
                        "expected": fixture["expected"],
                        "actual": actual,
                        "passed": actual == fixture["expected"],
                        "latency_ms": trace["latency_ms"],
                    }
                )
presets = []
for name, values in [
    ("Private context, capable local model", {"privacy": "local_only"}),
    ("Low memory, remote permitted", {"memory": 2, "privacy": "public"}),
    ("Offline, local model available", {"network": "offline"}),
    ("Private + low memory: cannot execute", {"privacy": "local_only", "memory": 2}),
    ("Complex task needs a cloud capability", {"complexity": "complex", "privacy": "public"}),
    ("Capable local model handles complex task", {"complexity": "complex", "local_reasoning": True}),
]:
    data = {
        "battery": 65,
        "memory": 8,
        "cpu": 40,
        "network": "online",
        "privacy": "local_only",
        "latency": 1800,
        "complexity": "light",
        "local_available": True,
        "local_reasoning": False,
        "cloud_available": True,
        "preferred_backend": "local",
        **values,
    }
    result = route_workload(
        DeviceContext(
            battery=data["battery"],
            available_memory_gb=data["memory"],
            cpu=data["cpu"],
            network=data["network"],
        ),
        lab_constraints(data["privacy"], data["latency"], data["complexity"], data["preferred_backend"]),
        lab_candidates(data["local_available"], data["local_reasoning"], data["cloud_available"]),
    )
    presets.append({"name": name, "input": data, "result": asdict(result)})

meeting_runs = {}
meeting_evaluation = []
for sample in SAMPLES:
    for experiment in EXPERIMENTS:
        service = MeetingService()
        session = service.create_session()
        if experiment["id"] == "busy":
            service.enqueue(session, "background")
            service.advance(session)
        job = service.enqueue(session, "meeting", sample["notes"], experiment["options"])
        receipt = service.advance(session)
        result = receipt["result"]
        result.update(
            queue=receipt["queue"],
            source="recorded_python_execution",
            sample_id=sample["id"],
            experiment_id=experiment["id"],
        )
        meeting_runs[f"{sample['id']}:{experiment['id']}"] = result
        expected = "blocked" if experiment["id"] == "blocked" else "complete"
        actions = len(result["document"]["actions"]) if result["document"] else 0
        expected_actions = 0 if expected == "blocked" else 1 if sample["id"] == "uncertain" else 2
        meeting_evaluation.append(
            {
                "sample": sample["title"],
                "experiment": experiment["title"],
                "expected_state": expected,
                "actual_state": result["state"],
                "expected_actions": expected_actions,
                "actual_actions": actions,
                "passed": result["state"] == expected and actions == expected_actions,
                "latency_ms": result["elapsed_ms"],
            }
        )
(OUT / "meeting.json").write_text(
    json.dumps({"samples": SAMPLES, "experiments": EXPERIMENTS, "runs": meeting_runs}, indent=2)
)

test_path = Path(__file__).parent / "reports/pytest.xml"
if not test_path.exists():
    raise SystemExit("Run pytest with --junitxml=ai-runtime/reports/pytest.xml before exporting.")
xml = ET.parse(test_path)
tests = [
    {
        "name": case.attrib["name"],
        "passed": case.find("failure") is None and case.find("error") is None,
        "skipped": case.find("skipped") is not None,
        "duration_seconds": float(case.attrib.get("time", 0)),
    }
    for case in xml.findall(".//testcase")
]
report = {
    "generated_at": datetime.now(UTC).isoformat(),
    "python": sys.version.split()[0],
    "tests": tests,
    "passed": sum(item["passed"] and not item["skipped"] for item in tests),
    "failed": sum(not item["passed"] for item in tests),
    "evaluation": evaluation,
    "evaluation_passed": sum(item["passed"] for item in evaluation),
    "mock_median_latency_ms": statistics.median(item["latency_ms"] for item in evaluation),
    "meeting_evaluation": meeting_evaluation,
    "meeting_passed": sum(item["passed"] for item in meeting_evaluation),
    "meeting_median_latency_ms": statistics.median(item["latency_ms"] for item in meeting_evaluation),
    "limitations": [
        "Small synthetic dataset; no production quality or hardware benchmark.",
        "Latency includes actual Python mock execution, not real LLM inference.",
        "Local/cloud adapters have network-isolated contract tests; real LLMs were not evaluated.",
        "No GPU, NPU, energy, or token measurements are fabricated.",
        "No claim of optimal scheduling or distributed exactly-once delivery.",
    ],
}
for name, payload in [
    ("fixtures", {"scenarios": catalog(), "traces": traces, "routing_presets": presets}),
    ("report", report),
]:
    (OUT / f"{name}.json").write_text(json.dumps(payload, indent=2))
with zipfile.ZipFile(OUT / "aegis-source.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    paths = [
        *Path(__file__).parent.glob("src/**/*.py"),
        *Path(__file__).parent.glob("tests/*.py"),
        Path(__file__),
        Path(__file__).parent / "pyproject.toml",
        Path(__file__).parent / "uv.lock",
        Path(__file__).parent / "README.md",
        *ROOT.glob("docs/aegis/**/*.md"),
    ]
    for path in paths:
        if path.is_file():
            archive.write(path, path.relative_to(ROOT))
print(
    f"Exported {len(traces)} recorded traces, {len(presets)} routing presets, {len(tests)} actual test results."
)
