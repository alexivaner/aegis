# Run the independent Aegis runtime

Python 3.12+ and uv are required. From the archive/repository root:

```sh
uv sync --project ai-runtime
uv run --project ai-runtime pytest ai-runtime/tests -q --junitxml=ai-runtime/reports/pytest.xml
uv run --project ai-runtime ruff check ai-runtime/src ai-runtime/tests ai-runtime/export_demo.py
uv run --project ai-runtime mypy --config-file ai-runtime/pyproject.toml ai-runtime/src/aegis
uv run --project ai-runtime uvicorn aegis.http:app --host 127.0.0.1 --port 8011
```

Interactive API documentation: `http://127.0.0.1:8011/docs`.

The primary website uses `POST /api/aegis/route` with fictional memory, CPU, battery, network, privacy and task requirements. It returns the actual Python policy admission and scheduler placement. It does not execute a model. The six offline examples are generated from this same policy. See the primary scenario lab documentation in `docs/aegis/README.md`.

The following APIs are retained workflow references, outside the simplified main UI.

Meeting flow: `POST /api/aegis/meeting/session` returns a workspace ID. `POST /api/aegis/meeting/enqueue` accepts that `session_id`, `kind="meeting"`, fictional `notes`, and optional policy/mode settings. `POST /api/aegis/meeting/step` with `session_id` advances one work turn and returns the result and queue. Use `kind="background"` to add the four-chunk reference index. `POST /api/aegis/meeting/plan` evaluates conditions without inference. `POST /api/aegis/meeting/cancel` cancels queued work by `job_id`.

Learning mode needs no credentials and makes no model/network request, including its fictional cloud path. It executes local text rules, policy and queue logic. Actual Ollama/cloud adapters are opt-in and use a meeting-specific structured/evidence schema; no model download occurs. See `docs/aegis/README.md` for exact policies, source-validation limits, queue/retention bounds and real-model setup.

The prior notification runtime (`/api/aegis/execute` and background APIs) remains a separate reference. Its optional SQLite adapter stores synthetic event metadata/decisions using `AEGIS_CONTEXT_DB`; it is not the meeting result store or a durable queue.

Keep the unauthenticated service on loopback. Nothing here is a production deployment.
