# Contextual Knowledge Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route any short, anaphoric client continuation to the knowledge model so it answers the preceding approved policy instead of ending the dialogue with a generic prompt.

**Architecture:** The orchestrator will decide that a turn is contextual from its linguistic form and the presence of the immediately preceding assistant reply, independently of whether the workflow model raised `knowledgeRequest`. `AgentTurnService` will use the same classifier when forming `contextualPolicy`, ensuring the KB prompt contains the exact preceding reply. A new self-contained question remains outside this route.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Specify contextual continuation routing

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:923-935`

- [x] **Step 1: Write failing orchestrator regressions**

Add tests in the existing `single-agent dialogue` suite with a previous AI reply about a vehicle being registered in UNA and a mocked workflow result without `knowledgeRequest`. For both `"и что делать"` and `"И что делать, если нет"`, assert `answerWithKnowledge` is called and its reply becomes the public reply. Add a counterexample `"какая ставка?"` asserting the contextual flag is false unless normal KB routing requested it.

- [x] **Step 2: Run the focused tests to verify failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual continuation"`

Expected: FAIL because the current exact regex does not recognise the two `и что делать` forms.

- [x] **Step 3: Implement a bounded anaphoric-continuation classifier**

Replace `isContextualFollowUpPhrase` with a detector that accepts one short sentence (maximum 160 characters) only when it consists of a continuation cue—such as `что делать`, `что делать если нет`, `что теперь`, `как быть`, `если нет`, `без этого`, or `почему`—and no independent subject/topic tokens. Keep `isContextualKnowledgeFollowUp` dependent on an actual preceding AI message.

- [x] **Step 4: Run the focused tests to verify success**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual continuation"`

Expected: PASS.

### Task 2: Preserve preceding policy in the knowledge prompt

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:3523-3558`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Write failing knowledge-context regressions**

Extend the existing UNA follow-up test table to cover `"и что делать"` and `"и что делать, если нет"`. Assert that `contextualPolicy` contains the previous UNA reply and that the mocked KB response is returned verbatim.

- [x] **Step 2: Run the focused tests to verify failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "UNA follow-up|preceding answer"`

Expected: FAIL for the newly added phrases because `contextualKnowledgePolicy` uses the same narrow regex.

- [x] **Step 3: Share the same continuation grammar in `AgentTurnService`**

Update its contextual follow-up detector to recognise the same bounded continuation forms, so `answerWithKnowledge` always supplies `contextualPolicy` for turns the orchestrator routes to KB.

- [x] **Step 4: Run the focused tests to verify success**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "UNA follow-up|preceding answer"`

Expected: PASS.

### Task 3: Verify the combined dialogue path

**Files:**
- Verify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Verify: `apps/api/src/dialogue/agent-turn.service.ts`

- [x] **Step 1: Run focused contextual and knowledge-routing coverage**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual|UNA follow-up|preceding answer"`

Expected: PASS.

- [x] **Step 2: Type-check the API package**

Run: `pnpm --filter @ailyn/api typecheck`

Expected: PASS.

- [x] **Step 3: Inspect the diff for scope and formatting**

Run: `git diff --check && git diff -- apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors; only contextual-routing code and regression tests change.
