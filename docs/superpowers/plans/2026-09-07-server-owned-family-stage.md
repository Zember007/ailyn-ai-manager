# Server-Owned Family Stage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advance family-status collection through a server-owned marital-state flow without repeating a recorded marital-status question.

**Architecture:** The model and deterministic recognizers extract facts from natural language; the server computes the next family sub-step and owns the exact client-facing question. A married client chooses how notarised spousal consent will be handled; a divorced client answers when the car was bought; a single client immediately completes the family stage.

**Tech Stack:** TypeScript, NestJS, Zod, Vitest.

---

### Task 1: Write family-flow regressions

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a married-client test**

```ts
// Given familyStatus is saved as married, expect consent guidance and the
// server-owned question about arranging it at the office, never the family
// status question again.
```

- [ ] **Step 2: Add divorced-client tests**

```ts
// "Я в разводе" -> no former-spouse consent + question when car was bought.
// "Купил в браке" -> certificate guidance + next stage; no repeated status.
// "После развода" -> certificate not required + next stage.
```

- [ ] **Step 3: Add consent-choice and spouse-away tests**

```ts
// A clear yes/no to office consent closes the married sub-stage. A spouse
// away from Bishkek receives the approved remote-notary guidance and does not
// schedule a visit until consent is available.
```

### Task 2: Add durable facts and derive completion

**Files:**
- Modify: `packages/business-rules/src/index.ts`
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts`

- [ ] **Step 1: Add `spouseConsentAtOffice?: boolean` to `ApplicationFacts` and the agent Zod patch**

```ts
spouseConsentAtOffice?: boolean;
```

- [ ] **Step 2: Make `deriveStageCompletion` close family only after its applicable sub-step**

```ts
const family = carPhoto && Boolean(facts.familyStatus)
  && (facts.familyStatus !== "married" || facts.spouseConsentReady === true || facts.spouseConsentAtOffice !== undefined)
  && (facts.familyStatus !== "divorced" || facts.vehicleBoughtDuringMarriage !== undefined);
```

### Task 3: Recognize family sub-answers and compose server questions

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/ai/prompts/agent.system.md`

- [ ] **Step 1: Add deterministic contextual patches**

Recognize marital status, car purchase timing after divorce, spouse-away phrasing, and yes/no after the office-consent question.

- [ ] **Step 2: Replace the generic family question with branching server text**

```ts
// married -> consent explanation + office-consent choice
// divorced -> former-spouse consent not required + purchase-timing question
// single -> standard flow continues
```

- [ ] **Step 3: Add transition notices for a newly answered divorce sub-step or declined office consent**

```ts
// bought during marriage -> original divorce certificate / optional photo
// bought after divorce -> certificate not required
// office consent declined -> bring original consent to visit
```

- [ ] **Step 4: Align prompt contract with server-owned family questions**

Tell the model to extract the sub-facts but not formulate any family-flow question.

### Task 4: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

- [ ] **Step 1: Run dialogue tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] **Step 2: Run static checks**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
