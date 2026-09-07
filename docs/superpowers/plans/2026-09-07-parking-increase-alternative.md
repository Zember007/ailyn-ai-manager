# Parking Increase Alternative Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain an over-limit request clearly and offer parking whenever it increases the available maximum, even when it does not fully cover the requested sum.

**Architecture:** Keep `LoanPricing` unchanged. `AgentTurnService` compares the selected without-storage public maximum with the parking public maximum and produces the client-facing choice from those server-calculated values only.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Add a failing dialogue regression

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Test a 600,000 request when no-storage allows 200,000 and parking allows 500,000**

```ts
expect(output.reply).toContain("Со стоянкой при текущей стоимости автомобиля доступно до 500 000 сом");
expect(output.reply).toContain("600 000 сом также не проходит");
expect(output.reply).toContain("перейти на программу со стоянкой и рассмотреть сумму до 500 000 сом");
```

- [x] **Step 2: Run the dialogue suite and confirm it fails before implementation**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: current message offers only 200,000 and does not name the 500,000 parking alternative.

### Task 2: Render the server-owned increase alternative

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:583-596`

- [x] **Step 1: Replace the `parkingCoversRequest` branch with a comparison against the selected maximum**

```ts
const parkingImprovesMaximum = pricing?.parking.available
  && typeof pricing.parking.publicMax === "number"
  && pricing.parking.publicMax > selectedPricing.publicMax;
```

- [x] **Step 2: State both calculated limits when parking improves the maximum but cannot cover the request**

```ts
return `По программе без изъятия доступно до ${limit} сом. Сумма ${requested} сом по этой программе не проходит. Со стоянкой при текущей стоимости автомобиля доступно до ${parkingLimit} сом, поэтому ${requested} сом также не проходит. Могу продолжить либо на сумму до ${limit} сом без изъятия, либо перейти на программу со стоянкой и рассмотреть сумму до ${parkingLimit} сом.`;
```

- [x] **Step 3: Re-run the focused test and confirm it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no-storage is not changed; the client sees the reason and both valid maxima.

### Task 3: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Run dialogue and pricing regression tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts packages/business-rules/src/index.spec.ts`

- [x] **Step 2: Run type checking and whitespace validation**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
