# Stage 1 Gap Analysis

## Repository Audit

The repository already had a pnpm monorepo structure with NestJS API, Next.js admin, Prisma schema, shared/config/schema packages, and a placeholder business-rules package.

## Gaps Found

- AI health/config referenced OpenAI env and wording.
- API domain controllers returned placeholders instead of Stage 1 data.
- Business rules returned `not_configured` and did not cover confirmed critical acceptance rules.
- Web Admin was a JSON dashboard and echo form, not a test conversation workspace.
- Prisma schema lacked Stage 1-specific settings, fact history, scenario runs, and detailed state enum.
- Knowledge module existed only as an empty module.
- Attachments and audit modules existed only as empty modules.
- Scenario pipeline existed as a smoke test only.
- Wazzup and channel abstractions were not present.

## Implemented Stage 1 Direction

- RouterAI provider abstraction with local fallback for development without secrets.
- Web Test normalized inbound path through `DialogueOrchestratorService`.
- Deterministic TypeScript rules for confirmed critical Stage 1 refusal and limit branches.
- In-memory Stage 1 store for immediate admin/scenario operation, with Prisma schema updated for production persistence.
- Admin surfaces for chat, lead card, debug, settings, knowledge, audit, and scenario runner.
- Scenario runner parses `docs/acceptance/ailyn_stage1_scenarios.md` and preserves `BLOCKED`.

## Remaining Risk

RouterAI real request/response schemas and Wazzup webhook/outbound schemas must be verified against official documentation before production traffic.
