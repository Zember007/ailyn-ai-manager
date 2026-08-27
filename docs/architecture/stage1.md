# Stage 1 Architecture

Stage 1 is a working vertical slice for internal testing. The Web Admin sends normalized test messages to the API. `DialogueOrchestratorService` coordinates extraction, fact updates, deterministic rules, response planning, generation, validation, and persistence.

Primary runtime modules:

- `ai`: `AiProvider`, `RouterAiProvider`, `RouterAiClient`.
- `channels`: normalized channel interfaces, Web Test, Wazzup boundary.
- `dialogue`: orchestrator, response plan, response validator, Stage 1 store.
- `business-rules`: deterministic eligibility and limit logic.
- `settings`: editable Stage 1 settings contract.
- `knowledge`: explicit knowledge items, not scenario RAG.
- `scenarios`: acceptance parser and runner.
- `audit` and `attachments`: observable Stage 1 history and uploaded media state.

The current local store keeps the Admin and runner usable without requiring a running database during development. Prisma schema is updated with the production persistence contract.
