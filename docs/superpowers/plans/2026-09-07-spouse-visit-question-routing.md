# Spouse Visit Question Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route semantic questions about bringing a spouse to a visit to the approved spouse-consent answer, never to the guarantor branch.

**Architecture:** `AgentTurnService` identifies a direct spouse/visit intent independently of the incomplete application stage and gives the approved reply priority over model prose. The system prompt teaches the model the same semantic distinction for flexible phrasing and future knowledge-routing turns.

**Tech Stack:** TypeScript, NestJS, Vitest, Markdown prompt.

---

### Task 1: Regression test

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Simulate an open guarantor stage and a model reply about a guarantor for “А жена нужна при визите?”**

```ts
expect(output.reply).toContain("Возьмите с собой супругу (супруга) для нотариального оформления согласия.");
expect(output.reply).toContain("Если согласие у Вас будет на руках, присутствие супруги (супруга) необязательно.");
expect(output.reply).not.toContain("поручител");
```

- [ ] **Step 2: Run the focused dialogue suite and confirm it fails before implementation**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the model's guarantor response is retained.

### Task 2: Implement direct spouse-visit intent

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:464-470`
- Modify: `apps/api/src/ai/prompts/agent.system.md`

- [ ] **Step 1: Add `spouseVisitAnswer(input)` for wife/husband/spouse plus visit/arrival/presence/bringing semantics**

```ts
const SPOUSE_VISIT_ANSWER = "Возьмите с собой супругу (супруга) для нотариального оформления согласия. Если согласие у Вас будет на руках, присутствие супруги (супруга) необязательно.";
```

- [ ] **Step 2: Give the direct answer priority over model prose, while allowing the server workflow follow-up to remain**

```ts
const directAnswer = spouseVisitAnswer(input) ?? familyNotice ?? maximumLoanInputReply ?? maximumLoanReply;
```

- [ ] **Step 3: Instruct the model that spouse-visit questions are never guarantor questions**

```md
Question forms about a wife, husband, or spouse attending a visit concern spouse consent, not a guarantor.
```

- [ ] **Step 4: Re-run the focused suite and confirm it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: approved spouse guidance appears before the server's earliest incomplete-stage follow-up.

### Task 3: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Run dialogue regression tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts packages/business-rules/src/index.spec.ts`

- [ ] **Step 2: Run type checking and whitespace validation**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
