# Server-Owned Limit Prose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a model from adding contradictory eligibility explanations when the server has already produced the canonical over-limit response.

**Architecture:** Keep the model's acknowledgement and unrelated FAQ text. Before appending a server `requestedAmountLimitReply`, remove only sentence-shaped model prose that asserts a program/guarantor/limit refusal; the server remains the single authority for calculated limits.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Regression test

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Make the 600,000 / 200,000 / 500,000 regression use the model's erroneous “без поручителя” explanation**

```ts
reply: "Поняла, Вам всё-таки нужно 600 000 сом. По этой программе для Вашей прописки такой лимит без поручителя не проходит."
expect(output.reply).not.toContain("без поручителя");
expect(output.reply).toContain("Со стоянкой при текущей стоимости автомобиля доступно до 500 000 сом");
```

- [x] **Step 2: Run the focused suite and confirm it fails before implementation**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the model's incorrect eligibility sentence remains before the server reply.

### Task 2: Strip only model-owned limit claims

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:466-480`

- [x] **Step 1: Apply a `removeModelLimitClaim` helper when `requestedAmountLimit` exists**

```ts
const serverSafeReply = requestedAmountLimit
  ? removeModelLimitClaim(guardedModelReply)
  : guardedModelReply;
```

- [x] **Step 2: Remove only sentences containing a program/guarantor limit rejection**

```ts
return reply.split(/(?<=[?!.])(?=\s|$)/gu)
  .filter((sentence) => !/(?:программ|лимит|поручител).{0,160}(?:не\s+проход|не\s+подход|не\s+доступ)/iu.test(sentence))
  .join("").trim();
```

- [x] **Step 3: Run the focused suite and confirm it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: acknowledgement remains; only the server limit explanation is shown.

### Task 3: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Run the dialogue regression suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts packages/business-rules/src/index.spec.ts`

- [x] **Step 2: Run type checking and whitespace validation**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
