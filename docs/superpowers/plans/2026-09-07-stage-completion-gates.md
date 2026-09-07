# Stage Completion Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dialogue model interpret client language naturally while the server prevents visits and later stages until the application prerequisites are completed.

**Architecture:** Persist server-derived stage-completion markers in `ApplicationFacts`; never accept them from an agent response. The model receives those markers and owns semantic interpretation of confirmations, while the turn boundary discards premature visit facts and replaces only a premature visit question with the currently required stage question.

**Tech Stack:** TypeScript, NestJS, Vitest, existing `ApplicationFacts` persistence.

---

### Task 1: Derive durable progress from application facts

**Files:**

- Modify: `packages/business-rules/src/index.ts`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts`
- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

- [ ] **Step 1: Define a server-owned progress record**

Add `StageCompletion` and `ApplicationFacts.stageCompletion` with these fields:

```ts
export interface StageCompletion {
  vehicle: boolean;
  requestedAmount: boolean;
  program: boolean;
  residence: boolean;
  guarantor: boolean;
  documents: boolean;
  carPhoto: boolean;
  family: boolean;
  readyForVisit: boolean;
  visit: boolean;
}
```

- [ ] **Step 2: Derive, rather than trust, all markers**

Implement `deriveStageCompletion(facts)` in `agent-turn-reconciliation.ts`. It must require model/year/value before `vehicle=true`; then amount, programme, and canonical residence in order. `readyForVisit` must require guarantor where applicable, documents supplied or explicitly declined, car photo supplied or declined, and the resolved family branch.

- [ ] **Step 3: Verify the progression shape**

Add this assertion:

```ts
expect(deriveStageCompletion(facts)).toMatchObject({
  vehicle: true, requestedAmount: true, program: true, residence: true,
  guarantor: true, documents: false, readyForVisit: false, visit: false
});
```

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: PASS.

### Task 2: Persist progress and hard-gate visit creation

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Store server-derived markers after reconciliation**

At the persistence boundary, build the stored facts as:

```ts
const reconciledFacts = effectiveFactsForTurn({ previous, modelPatch, explicitFacts: {}, currencyFacts, attachmentFacts });
const effectiveFacts = { ...reconciledFacts, stageCompletion: deriveStageCompletion(reconciledFacts) };
```

- [ ] **Step 2: Remove visit assertions until the stage is open**

Before final reconciliation, calculate progress from the candidate patch. When `readyForVisit` is false, omit only `visitRequested`, `visitDate`, `visitTime`, and `visitConfirmationPending`; do not discard the model's natural-language interpretation of other facts.

- [ ] **Step 3: Repair only a premature visit question**

If a model asks for a visit while `readyForVisit` is false, replace that question with the concrete earliest missing stage: vehicle/value, amount, programme, prescribed residence choice, guarantor, documents, car photo, or family status.

- [ ] **Step 4: Verify visit cannot bypass documents**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the regression where a model emits `visitRequested`, date, time, and a visit question before documents saves no visit fields and requests ID/registration photos instead.

### Task 3: Keep natural-language understanding in the model

**Files:**

- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Describe the server-owned markers and ordering**

Add prompt rules that `leadCard.stageCompletion` is computed by the server; the model cannot write it. State the mandatory ordering through documents, car photo, family, and visit.

- [ ] **Step 2: Preserve semantic confirmations**

In the same prompt, require that a direct pending binary question is resolved by meaning in any language or wording: unambiguous confirmation saves `true`, unambiguous refusal saves `false` or the applicable decline flag. Do not require a fixed literal `да`.

- [ ] **Step 3: Do not activate a guarantor early**

Require model/year/value/amount before exposing the guarantor branch in `guarantorRequirementFor`:

```ts
const baseApplicationComplete = Boolean(
  facts.vehicleModel && facts.vehicleYear &&
  facts.vehicleValue !== undefined && facts.requestedAmount !== undefined
);
```

- [ ] **Step 4: Verify the context**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: an OTHER_KG / without-storage card without value and requested amount supplies `{ required: false, reason: "not_applicable" }` to the model.

### Task 4: Verify the integrated change

**Files:**

- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`

- [ ] **Step 1: Run regressions**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run static checks**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: both commands exit with code 0.
