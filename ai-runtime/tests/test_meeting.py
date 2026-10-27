import pytest
from fastapi.testclient import TestClient

from aegis.adapters import CloudInference, OllamaInference
from aegis.composition import RuntimeService
from aegis.domain import Backend
from aegis.http import create_app
from aegis.meeting_adapters import ExtractiveMeetingBackend, ModelMeetingBackend
from aegis.meeting_domain import CooperativeQueue, parse_notes, validate_document
from aegis.meeting_runtime import EXPERIMENTS, SAMPLES, MeetingService


@pytest.mark.parametrize("sample", SAMPLES)
def test_extracts_evidence_for_each_sample(sample):
    sentences = parse_notes(sample["notes"])
    document = ExtractiveMeetingBackend(Backend.LOCAL).summarize(sentences, 1)
    assert validate_document(document, sentences) == document
    assert len(document["summary"]) == 3
    assert document["decisions"]


def test_task_owner_deadline_and_missing_deadline_are_literal():
    service = MeetingService()
    result = service.execute(SAMPLES[0]["notes"], {})
    assert result["state"] == "complete"
    assert result["document"]["actions"][0]["owner"] == "Maya"
    assert result["document"]["actions"][0]["due"] == "Friday"
    uncertain = service.execute(SAMPLES[2]["notes"], {})
    assert uncertain["document"]["actions"][0]["due"] is None
    assert len(uncertain["document"]["actions"]) == 1


def test_editing_notes_changes_result_without_fabricating_unsupported_commitments():
    result = MeetingService().execute(
        "Mira: I'll send the revised notes by Wednesday.\nJo: We should consider a new logo.", {}
    )
    assert result["document"]["actions"] == [
        {
            "text": "Send the revised notes",
            "source_ids": ["s1"],
            "evidence_quote": "I'll send the revised notes by Wednesday.",
            "owner": "Mira",
            "due": "Wednesday",
        }
    ]


@pytest.mark.parametrize("change", ["source", "quote", "owner", "due", "extra"])
def test_untrusted_output_cannot_invent_evidence_or_metadata(change):
    sentences = parse_notes(SAMPLES[0]["notes"])
    document = ExtractiveMeetingBackend(Backend.LOCAL).summarize(sentences, 1)
    item = document["actions"][0]
    if change == "source":
        item["source_ids"] = ["s999"]
    if change == "quote":
        item["evidence_quote"] = "Nothing in the meeting says this."
    if change == "owner":
        item["owner"] = "May"
    if change == "due":
        item["due"] = "Next year"
    if change == "extra":
        item["tool"] = "execute_shell"
    with pytest.raises(ValueError):
        validate_document(document, sentences)


@pytest.mark.parametrize(
    "notes", ["short", "x" * 6001, "line with a sufficiently long input\n" * 21, "A" * 801]
)
def test_bounded_input(notes):
    with pytest.raises(ValueError):
        parse_notes(notes)


@pytest.mark.parametrize(
    "options,backend",
    [
        ({}, "local"),
        ({"local_available": False}, None),
        ({"private": False, "local_available": False}, "cloud"),
        ({"network": "offline"}, "local"),
        ({"private": False, "network": "offline", "local_available": False}, None),
        ({"mode": "model"}, None),
    ],
)
def test_plan_respects_privacy_network_and_available_models(options, backend):
    assert MeetingService().plan(options)["placement"]["backend"] == backend


def test_timeout_fallback_cannot_bypass_privacy():
    service = MeetingService()
    private = service.execute(SAMPLES[0]["notes"], {"failure": "timeout"})
    assert private["state"] == "failed" and private["document"] is None
    assert {attempt["provider"] for attempt in private["attempts"]} == {"demo-local"}
    permitted = service.execute(SAMPLES[0]["notes"], {"failure": "timeout", "private": False})
    assert permitted["state"] == "complete" and permitted["actual_backend"] == "demo-cloud"
    assert permitted["execution_kind"] == "extractive_learning_rules"
    assert len(permitted["attempts"]) == 3


def test_invalid_evidence_is_not_retried_as_a_transient_error():
    result = MeetingService().execute(SAMPLES[0]["notes"], {"failure": "invalid_output"})
    assert result["state"] == "failed" and len(result["attempts"]) == 1


def test_blocked_result_has_no_fabricated_document():
    result = MeetingService().execute(SAMPLES[0]["notes"], {"local_available": False})
    assert result["state"] == "blocked" and result["document"] is None
    assert result["actual_backend"] is None
    assert not any(step["id"] == "execution" for step in result["trace"])


def test_learning_cloud_path_never_calls_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Learning mode must not call a model")

    monkeypatch.setattr("aegis.meeting_adapters.bounded_json", forbidden)
    result = MeetingService().execute(SAMPLES[0]["notes"], {"private": False, "local_available": False})
    assert result["actual_backend"] == "demo-cloud"


@pytest.mark.parametrize(
    "provider",
    [
        OllamaInference("http://127.0.0.1:11434", "test", True),
        CloudInference("https://example.test/api", "test", "unit-test-token"),
    ],
)
def test_real_model_adapter_contract_with_isolated_http_fixture(monkeypatch, provider):
    sentences = parse_notes(SAMPLES[0]["notes"])
    raw = ExtractiveMeetingBackend(Backend.LOCAL).summarize(sentences, 1)
    import json

    def fake(url, payload, timeout, headers=None):
        assert "source_ids" in str(payload) and "Maya" in str(payload)
        assert payload["messages"][0]["role"] == "system"
        return {
            "message": {"content": json.dumps(raw)},
            "choices": [{"message": {"content": json.dumps(raw)}}],
        }

    monkeypatch.setattr("aegis.meeting_adapters.bounded_json", fake)
    assert validate_document(ModelMeetingBackend(provider).summarize(sentences, 1), sentences) == raw


def test_foreground_request_precedes_background_and_background_really_indexes():
    service = MeetingService()
    session = service.create_session()
    background = service.enqueue(session, "background")
    first = service.advance(session)
    assert first["queue"]["indexed_words"] > 0
    foreground = service.enqueue(session, "meeting", SAMPLES[0]["notes"])
    result = service.advance(session)
    assert result["job_id"] == foreground["job_id"]
    assert result["result"]["state"] == "complete"
    assert (
        next(item for item in result["queue"]["items"] if item["id"] == background["job_id"])["status"]
        == "paused"
    )
    assert any("takes priority" in event for event in result["queue"]["events"])


def test_aging_gives_background_a_turn_under_continuous_interactive_requests():
    queue = CooperativeQueue()
    background = queue.add("background", "Reference indexing")
    selected = []
    for _ in range(7):
        queue.add("meeting", "Interactive summary")
        job = queue.next()
        selected.append(job.kind)
        job.done += 1
        job.status = "complete" if job.kind == "meeting" else "paused"
    assert "background" in selected[:6]
    assert background.done >= 1


def test_queue_capacity_cancellation_and_session_expiry():
    service = MeetingService()
    session = service.create_session()
    job = service.enqueue(session, "background")
    service.cancel(session, job["job_id"])
    assert service.advance(session)["job_id"] is None
    queue = CooperativeQueue()
    for _ in range(12):
        queue.add("meeting", "Pending")
    with pytest.raises(ValueError):
        queue.add("meeting", "Too many")
    for _ in range(17):
        service.create_session()
    assert len(service.sessions) == 16
    with pytest.raises(ValueError):
        service.advance(session)


def test_meeting_api_contract_and_input_validation():
    with TestClient(create_app(RuntimeService())) as client:
        assert client.get("/api/aegis/meeting/health").json()["capabilities"]["learning"]
        session = client.post("/api/aegis/meeting/session").json()["session_id"]
        assert (
            client.post("/api/aegis/meeting/plan", json={"arbitrary_url": "https://example.test"}).status_code
            == 422
        )
        assert (
            client.post(
                "/api/aegis/meeting/enqueue", json={"session_id": session, "notes": "tiny"}
            ).status_code
            == 400
        )
        job = client.post(
            "/api/aegis/meeting/enqueue", json={"session_id": session, "notes": SAMPLES[0]["notes"]}
        ).json()
        result = client.post("/api/aegis/meeting/step", json={"session_id": session}).json()
        assert result["job_id"] == job["job_id"] and result["result"]["state"] == "complete"


@pytest.mark.parametrize("experiment", EXPERIMENTS)
def test_learning_experiments_have_expected_outcomes(experiment):
    result = MeetingService().execute(SAMPLES[0]["notes"], experiment["options"])
    assert result["state"] == ("blocked" if experiment["id"] == "blocked" else "complete")
    assert result["elapsed_ms"] >= 0
    # Trace payloads hold counts/IDs/placement, not notes, evidence quotes or API keys.
    assert "I'll send" not in str(result["trace"])


def test_idle_workspace_really_expires_on_access():
    import time

    service = MeetingService()
    session = service.create_session()
    queue, _ = service.sessions[session]
    service.sessions[session] = (queue, time.monotonic() - 1801)
    with pytest.raises(ValueError):
        service.advance(session)
    assert session not in service.sessions


def test_empty_model_document_is_not_accepted_as_success():
    with pytest.raises(ValueError):
        validate_document({"summary": [], "actions": [], "decisions": []}, parse_notes(SAMPLES[0]["notes"]))


@pytest.mark.parametrize("failure", ["timeout", "invalid_output"])
def test_fault_injection_does_not_call_an_actual_model(monkeypatch, failure):
    def forbidden(*args, **kwargs):
        raise AssertionError("Injected faults must replace actual provider calls")

    monkeypatch.setattr("aegis.meeting_adapters.bounded_json", forbidden)
    service = MeetingService(OllamaInference("http://127.0.0.1:11434", "test", True))
    result = service.execute(SAMPLES[0]["notes"], {"mode": "model", "failure": failure})
    assert result["state"] == "failed"
    assert result["document"] is None
