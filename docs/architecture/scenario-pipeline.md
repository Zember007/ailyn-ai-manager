# Scenario Pipeline

Acceptance source: `docs/acceptance/ailyn_stage1_scenarios.md`.

The runner parses every `S1-*` row and returns `PASS`, `FAIL`, or `BLOCKED`. Rows marked `Blocked=YES` remain `BLOCKED`; confirmed data is not invented for them.

Critical financial and refusal branches use deterministic assertions against `packages/business-rules`. Other non-blocked scenarios are tracked as Stage 1 category coverage and surfaced in Admin.

Commands:

- `pnpm test:scenarios`
- `POST /api/scenarios/run`
- `GET /api/scenarios/runs`
- `GET /api/scenarios/runs/:id`
