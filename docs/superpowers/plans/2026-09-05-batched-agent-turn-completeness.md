# Batched Agent Turn Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the existing single RouterAI agent processes every message and question in a batched client turn, while receiving authoritative personal-loan pricing and locality facts.

**Architecture:** Preserve `MessagesController → DialogueTurnBatcherService → DialogueOrchestratorService → AgentTurnService → one RouterAI turn`. The orchestrator will carry an ordered `currentTurnMessages` view to the model; it will not parse intent. A pure pricing helper computes only rules that code owns, and the prompt/stage instructions require the model to apply all messages chronologically before it writes the reply and fact patch.

**Tech Stack:** NestJS, TypeScript, Vitest, Zod, pnpm workspace.

---

### Task 1: Add ordered batch context and authoritative pricing

**Files:**
- Create: `apps/api/src/dialogue/loan-pricing.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing unit tests** asserting that a two-message `receiveBatch()` forwards both ordered messages to `AgentTurnService`, and that a `1_748_982` KGS vehicle in Tokmok has parking `rawMax: 874_491`, public maximum `870_000`, rate `2.4`, and daily fee `130`.

- [ ] **Step 2: Implement the pure `buildLoanPricing()` helper.** Resolve locality with `resolveKyrgyzstanLocality`, calculate `without_storage` and `parking` personal caps using exact values, floor public caps to 10,000, and expose availability without interpreting client language.

- [ ] **Step 3: Extend the existing AgentTurn input and serialized context.** Preserve `currentMessage` for compatibility and add a `currentTurnMessages` array containing ordered `{ index, text }` items. Attach `pricing` built from current facts and settings.

- [ ] **Step 4: Run the focused test.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS, with no change to batcher semantics or number of main model turns.

### Task 2: Require complete compound-turn handling from the agent

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add the atomic ordered-turn rule to the system prompt.** Require an internal chronological pass over every `currentTurnMessages` entry, collection of unanswered questions, latest-explicit-value precedence, fact patching, and a self-check before JSON output. Require history questions that remain unanswered to be answered before a new stage question.

- [ ] **Step 2: Update contextual stage instructions.** Cover question plus state change, hypothetical program questions versus explicit switches, personal pricing, Tokmok resolver output, corrected family status, and weekend visit rescheduling without automatic time migration.

- [ ] **Step 3: Add regression tests with mocked model results** for: interest question plus parking switch; two questions in one batch; interest plus amount correction; documents question plus family correction; three state changes; and hypothetical parking question with final `without_storage` selection.

- [ ] **Step 4: Run the focused test.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS, with preserved model ownership of language interpretation and replies.

### Task 3: Preserve price authority, locality, and aborted-batch delivery

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts`
- Modify: `apps/api/src/dialogue/dialogue-turn-batcher.service.spec.ts`
- Modify: `packages/business-rules/src/index.spec.ts`
- Test: `apps/api/src/dialogue/loan-pricing.spec.ts`

- [ ] **Step 1: Test pricing boundaries and Tokmok.** Verify parking uses 50%, public limits never exceed raw limits, `without_storage` outside Bishkek/Chuy is unavailable below 1,000,000, and Tokmok resolves to `BISHKEK_CHUY` / `Чуйская область`.

- [ ] **Step 2: Make reconciliation consume the pricing helper for stored preliminary limits** so the persisted deterministic number and the model context have one source of truth, without calling legacy `evaluateApplication()`.

- [ ] **Step 3: Add the superseded-inference batcher test.** Start a receive call, enqueue a second message while the first inference is pending, abort the old signal, and verify the restarted call receives both original messages in order.

- [ ] **Step 4: Run pricing, locality, and batcher tests.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-turn-batcher.service.spec.ts apps/api/src/dialogue/loan-pricing.spec.ts packages/business-rules/src/index.spec.ts`

Expected: PASS.

### Task 4: Verify the integrated agent-led flow

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-turn-batcher.service.spec.ts`
- Test: `apps/api/src/dialogue/loan-pricing.spec.ts`

- [ ] **Step 1: Run the complete dialogue-focused suite.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/dialogue-turn-batcher.service.spec.ts apps/api/src/dialogue/loan-pricing.spec.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run workspace verification.**

Run: `pnpm test && pnpm test:scenarios && pnpm typecheck && pnpm lint && git diff --check`

Expected: all commands pass, or any pre-existing unrelated failure is reported with its exact command and output.

## Plan self-review

- Coverage: ordered current-turn context, all-question handling, latest-value precedence, program-switch semantics, pure personal pricing, public rounding, Tokmok locality resolution, abort/restart batching, and requested regression coverage are included.
- Deliberate exclusions: no deterministic NLP parser, reply templates, `evaluateApplication()` dialogue engine, additional extraction path, state-machine rewrite, or change to the one-main-agent-turn architecture.
