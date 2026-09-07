# Guarantor and Limit Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make guarantor and loan-limit decisions explicit server-owned branches after the application facts are complete.

**Architecture:** `AgentTurnService` owns exact guarantor requirements, refusal/parking alternatives, selected-program maximum disclosure, and over-limit choices. The model only extracts consent, refusal, a program switch, and updated client facts. Residence changes continue to recalculate eligibility from canonical facts, so the guarantor branch disappears immediately for Bishkek/Chuy.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Add failing server-flow tests

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Test canonical guarantor requirements and a clear yes**

```ts
// OTHER_KG + without_storage -> exact requirements; "да" -> guarantorAvailable=true
```

- [x] **Step 2: Test refusal, parking acceptance, and residence correction**

```ts
// "нет" -> parking alternative; "да" after it -> requestedProgram=parking.
// A Chuy locality correction removes the guarantor requirement.
```

- [x] **Step 3: Test selected limit disclosure and both over-limit branches**

```ts
// A complete selected program reports its publicMax even when amount fits.
// Without-storage excess offers amount reduction or parking only when parking fits;
// parking excess offers only reduction.
```

### Task 2: Implement server-owned branches

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts`

- [x] **Step 1: Make canonical guarantor prompt include age, location, presence, and ID requirements**
- [x] **Step 2: Interpret clear acceptance/refusal and parking alternative answers in context**
- [x] **Step 3: Emit selected-program public maximum once the required facts are known**
- [x] **Step 4: Restrict over-limit alternatives to viable server-priced programs**

### Task 3: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Run dialogue tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts packages/business-rules/src/index.spec.ts`

- [x] **Step 2: Run static checks**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
