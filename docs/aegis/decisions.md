# Architecture decisions

## Current scenario UI

The primary experience is preset selection followed by a local/cloud/blocked placement result. The existing policy and scheduler remain authoritative. Arbitrary condition changes call Python; offline previews only show recorded Python results. The execution-backend role explains the next boundary without claiming a model call. Detailed architecture/evidence is optional. The scheduler follows a selectable local/cloud preference among policy-admitted candidates, defaulting to local. Eleven controls are grouped by role; all four role inputs/outputs remain visible and update on every change. No optimal cost, energy or quality is claimed.

## Retained meeting workflow decisions

The historical decisions below document the retained meeting implementation, not the primary routing UI.

## ADR 001 — A bounded workflow

Use a small explicit Python workflow before adding an agent framework. Read notes, inspect context, admit candidates, place work, execute, validate evidence and record outcomes. Provider attempts and workspaces are bounded. This exposes failure/blocked states without implying open-ended autonomous planning. Revisit framework orchestration when resumability or dynamic graph behavior is a demonstrated need.

## ADR 002 — Purposeful application contracts

Meeting inference, policy admission, backend placement and time have explicit contracts. A task-specific meeting schema replaces the earlier notification schema for the retained meeting UI; old source remains as reference/regression coverage. Composition chooses extractive learning providers or actual model adapters. The domain remains framework-free. Contract upkeep costs wiring, but permits provider replacement and placement changes without weakening admission policy.

## ADR 003 — Privacy before execution; evidence before presentation

Private inputs cannot use cloud, even when local inference fails or is unavailable. Only policy-admitted alternatives may receive a retry/fallback. Output must have valid source IDs and literal evidence. Owners/deadlines must appear in a cited source. These checks support review, not semantic entailment guarantees. No external task/action executes. Actual model output still needs human review.

## ADR 004 — One policy, explicit learning provenance

Live controls call Python. Static previews use recorded Python experiments and disable arbitrary unsupported input. Learning local/cloud profiles are fictional and execute local text rules with no network calls; labels state this directly. Actual model mode is opt-in and uses configured providers only. No weights, hardware counters, token measurements or performance gains are invented.

## ADR 005 — Cooperative priority with aging

One bounded worker orders interactive meeting requests ahead of reference-indexing chunks. Waiting turns improve effective priority, giving background work controlled progress. The queue demonstrates a real rule and actual indexing work without claiming GPU scheduling, hard preemption or real-time deadlines. Model calls remain bounded blocking units. Session/results are ephemeral, capacity-limited and unauthenticated; durable multi-user deployment is future work.
