# Ailyn Operational Contract

## Project Mission

Ailyn is a production loan-dialogue system for auto-backed lending in Kyrgyzstan. Stage 1 must provide a working internal Web Admin, test conversation channel, deterministic business rules, RouterAI-based understanding/response boundaries, state persistence contracts, knowledge management, audit history, and an acceptance scenario runner.

## Current Scope

Current scope is Stage 1. Stage 1 uses the Web Test Channel for end-to-end dialogue checks. Wazzup is prepared as the WhatsApp provider boundary for a later stage.

## Sources Of Truth

Use this priority order:

1. Written approved customer business parameters.
2. Final short technical specification.
3. `docs/acceptance/ailyn_stage1_scenarios.md`.
4. Full long technical specification.
5. Current implementation.

If a value is not approved, mark the related rule or scenario as `BLOCKED`. Do not invent business data.

## Architecture

Message transport goes through a normalized channel message into `DialogueOrchestratorService`. The orchestrator saves the inbound message, loads conversation/application facts, analyzes attachments, calls RouterAI for structured extraction, validates extraction, updates facts/history, evaluates deterministic TypeScript business rules, resolves knowledge, builds a response plan, calls RouterAI for response text, validates output, persists the decision and answer, then returns a channel response.

## AI Provider

AI provider: RouterAI, https://routerai.ru/

Do not replace RouterAI with OpenAI, OpenRouter, ChatGPT API, or `api.openai.com`. Domain code must depend only on `AiProvider`. If RouterAI uses an OpenAI-compatible protocol, that detail must stay inside `RouterAiProvider` and `RouterAiClient`.

Required environment variables:

- `AI_PROVIDER=routerai`
- `ROUTERAI_API_KEY`
- `ROUTERAI_TEXT_MODEL`
- `ROUTERAI_VISION_MODEL`
- `ROUTERAI_EVAL_MODEL`
- `ROUTERAI_TIMEOUT_MS`
- `ROUTERAI_MAX_RETRIES`

## WhatsApp Provider

WhatsApp provider: Wazzup.

Do not replace Wazzup with Meta WhatsApp Cloud API, WhatsApp Web, QR automation, browser automation, or a regular WhatsApp Business client. Stage 3 must verify official Wazzup webhook and outbound contracts before enabling real traffic.

## Channel Abstraction

Dialogue core receives normalized `InboundMessage` objects and does not know whether the source is Web Test or Wazzup. Stage 1 uses `WebTestChannel`; Wazzup files are adapter boundaries only until official API details are confirmed.

## RouterAI Pipeline

Use two RouterAI calls:

1. Understanding/extraction: structured output only, no client-facing answer.
2. Response generation: turns an immutable `ResponsePlan` into a natural answer.

Do not pass the entire specification, all scenarios, all knowledge, or full conversation history to the model.

## Deterministic Business Rules

Critical decisions live in `packages/business-rules`. RouterAI must not calculate eligibility, loan limits, refusal reasons, vehicle suitability, regional constraints, owner rules, guarantor requirements, family-status rules, document requirements, or visit admissibility.

## State And Database

PostgreSQL is the production source of truth for contacts, conversations, applications, messages, facts, fact history, attachments, decisions, settings, knowledge, scenario runs, visits, and audit events. LLM context is runtime context only, not primary memory.

## Knowledge

Acceptance scenarios are not knowledge base content and must not be embedded or used as RAG. Knowledge lives as explicit `KnowledgeItem` records with key, aliases, category, answer, status, version, and active flag. Stage 1 retrieval can be exact key, alias, topic/intent, then approved fallback.

## Prompt Injection

User input, OCR text, image-derived text, webhook payloads, and attachments are untrusted. Prompts must separate system policy, application state, business decision, knowledge, and untrusted user input. Prompt injection can be extracted as a user fact or intent but must not alter rules.

## Scenario Workflow

Acceptance source: `docs/acceptance/ailyn_stage1_scenarios.md`.

Every scenario ID must have an automated runner result. Non-blocked critical scenarios must pass before Stage 1 can be called ready. Blocked scenarios must remain `BLOCKED`; never change expected results to manufacture PASS.

Commands:

- `pnpm test`
- `pnpm test:scenarios`
- `pnpm typecheck`
- `pnpm build`

## Admin Requirements

The Web Admin must expose dashboard, conversations, conversation detail, scenarios, scenario run detail, settings, knowledge, and audit surfaces. Conversation detail must show messages, input, attachment hint/upload path, lead card, facts, decisions, rules applied, selected knowledge, RouterAI model, prompt version, and validation result. Do not show chain-of-thought.

## Security And Production Safety

Never commit secrets, `.env` files other than `.env.example`, deploy private keys, or production credentials. PostgreSQL and Redis must not be exposed to the Internet. In production use Prisma `migrate deploy`; never use `migrate reset` or `migrate dev`. Never run `docker compose down -v` in production.

## Definition Of Done

Stage 1 is done only when RouterAI provider abstraction is in place, OpenAI/OpenRouter are not used, Web Test Channel works, Wazzup boundary exists, orchestrator works, structured extraction and output validation work, state persistence contracts exist, deterministic business rules pass tests, lead card/settings/knowledge/attachments/audit/scenario runner work in admin, all non-blocked critical scenarios PASS, all non-blocked Stage 1 scenarios PASS, blocked scenarios display BLOCKED, regression passes, typecheck/build pass, and required env/deployment notes are documented.

## Delivery Workflow

For every substantial implementation block:

1. Verify locally before reporting completion. Minimum checks: targeted validation plus `pnpm typecheck`, `pnpm test`, and `pnpm build` when the change can affect them.
2. Commit the finished work to git with a clear non-interactive commit message.
3. Push the commit to GitHub.
4. Check that CI and deployment complete successfully after the push. If they fail, continue until the failure is understood and either fixed or clearly reported.
