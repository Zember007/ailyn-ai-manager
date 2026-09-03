# Stage Gating and Limit Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the agent from calculating or announcing a personal loan limit before residence is known, and prevent it from skipping required dialogue stages.

**Architecture:** Keep business rules as the source of truth and add a server-side reply guard after model output. The guard will reconcile the model's facts/state, then replace replies that contradict the earliest missing requirement with the deterministic next question; valid replies remain unchanged.

**Tech Stack:** TypeScript, NestJS services, Vitest, `@ailyn/business-rules`.

---

### Task 1: Lock the reported regression in tests

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts` or the existing reconciliation test file if present
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a regression case** for facts containing vehicle, value 200000, requested amount 100000, and program `without_storage`, but no residence. Assert the reconciled limit is `null`, the next requirement is residence, and the client-facing reply does not contain `80 000`, `80 000`, documents, or a document request.
- [ ] **Step 2: Add a regression case** proving that a model reply claiming the application can proceed to documents is replaced by the residence question when residence is absent.
- [ ] **Step 3: Run the focused tests** with `pnpm exec vitest run apps/api/src/dialogue/...` and confirm the new cases fail before implementation.

### Task 2: Add a deterministic reply guard

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Reconcile the effective facts** after parsing the model response, using the existing `reconcileAgentTurn` path and the current business-rule settings.
- [ ] **Step 2: Detect an invalid stage transition** when the response mentions a personal limit, documents, or a later dialogue state while `reconcileAgentTurn` reports an earlier missing requirement.
- [ ] **Step 3: Replace only the invalid client reply** with the deterministic question for the earliest missing requirement; preserve the model's lead-card facts after schema validation.
- [ ] **Step 4: Ensure the specific reported turn produces exactly:** `Подскажите, пожалуйста, где прописан собственник автомобиля?`
- [ ] **Step 5: Keep legitimate limit replies intact** once residence is present, and ensure the selected-program limit—not a model-proposed value—is used.

### Task 3: Verify the full dialogue behavior

**Files:**
- Test: `apps/api/src/dialogue/agent-turn.service.spec.ts`
- Test: `tests/scenarios/dialogue-e2e.scenario.spec.ts`

- [ ] **Step 1: Run the focused dialogue and business-rule tests.**
- [ ] **Step 2: Run the existing scenario suite covering residence-before-limit and programme selection.
- [ ] **Step 3: Run the repository typecheck/build command from `package.json`.
- [ ] **Step 4: Review the diff and confirm no unrelated files or secrets are changed.
