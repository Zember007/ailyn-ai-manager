# Canonical Knowledge Answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure a matched approved FAQ is delivered from the server-owned canonical answer, never from model-authored factual prose.

**Architecture:** `selectRelevantDocumentation` already resolves a single `mandatoryAnswer` for an exact approved FAQ. `AgentTurnService.answerWithKnowledge` will make that answer authoritative after model validation, using the model only where no server-owned canonical answer exists. Contextual and lead-card-only cases retain their dedicated paths.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Lock the UNA FAQ to its approved wording

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:282-297`

- [x] **Step 1: Write a failing test**

Mock a knowledge-model reply that adds `«в автоломбарде Молодой»` and call `answerWithKnowledge` for `«В УНА нужна регистрация?»`. Assert the result equals the canonical `vehicle_registration_una.answerRu` string from `approvedKnowledgeSeeds`.

- [x] **Step 2: Run the focused test to verify failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "canonical UNA answer"`

Expected: FAIL because the current implementation returns the model reply.

- [x] **Step 3: Make `mandatoryAnswer` server-authoritative**

In `answerWithKnowledge`, select `documentation.mandatoryAnswer` before any model-authored reply whenever it is present and no special server-owned response overrides it. Continue to use the model output only for non-canonical retrieval and for determining whether an answer was found.

- [x] **Step 4: Run the focused test to verify success**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "canonical UNA answer"`

Expected: PASS.

### Task 2: Verify factual-answer boundaries

**Files:**
- Verify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Verify: `apps/api/src/dialogue/agent-turn.service.ts`

- [x] **Step 1: Run direct approved-FAQ coverage**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "canonical UNA answer|approved orientation|foreign registration|special equipment"`

Expected: PASS.

- [x] **Step 2: Type-check the API package and inspect whitespace**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: both commands exit successfully.
