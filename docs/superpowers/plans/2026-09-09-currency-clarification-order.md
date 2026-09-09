# Currency Clarification Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a currency clarification as the only active question and convert a subsequent currency-only answer into the originally stated requested loan amount.

**Architecture:** `AgentTurnService` will suppress the server workflow appender while the model asks a numeric currency-confirmation question. `DialogueOrchestratorService` will recognise a currency-only reply to that pending clarification, run the money normalizer, and recover the amount and field from the immediately preceding clarification as a deterministic fallback before NBKR conversion.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Prevent a next-stage question during a money clarification

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:748-785`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing test**

Call `AgentTurnService.run` with vehicle facts and a model reply `10 тысяч сом, верно?`. Assert the final reply contains that clarification and does not contain `Вас интересует займ без изъятия`.

- [ ] **Step 2: Run the focused test**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='currency clarification'`.

Expected: FAIL because `serverWorkflowFollowUp` currently appends the programme question.

- [ ] **Step 3: Implement the workflow guard**

Add `hasPendingMoneyCurrencyClarification(reply)` in `agent-turn.service.ts`. It must recognise a question that combines a numeric amount, a currency unit, and `верно` or `правильно`. In `finalizeAgentPayload`, do not calculate or append `serverWorkflowFollowUp` while this helper returns true.

- [ ] **Step 4: Re-run the focused test**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='currency clarification'`.

Expected: PASS.

### Task 2: Resolve a currency-only correction into the pending amount

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:39-52,229-299`
- Modify: `apps/api/src/ai/prompts/money-normalization.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing conversion test**

Build a two-message history ending in `10 тысяч сом, верно?`; submit `долларов`; mock the normalizer as empty and NBKR conversion of `10_000 USD` as `870_000 KGS`. Assert the agent receives `requestedAmount: 870_000`, `requestedAmountSourceCurrency: "USD"`, a conversion block for the loan amount, and only the programme question after conversion.

- [ ] **Step 2: Run the focused test**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='currency-only correction'`.

Expected: FAIL because `долларов` has no numeric token and does not invoke money normalisation.

- [ ] **Step 3: Implement the correction path**

Detect an explicit foreign-currency-only reply to the immediate money-confirmation question. Include that condition in the orchestrator's normalizer gate. Add a special fallback in `supplementNormalizedMoney` that extracts only the confirmed amount from that last AI question, finds the amount role from the preceding money question, and applies the explicitly named current-turn foreign currency. Extend the normalizer prompt with the same narrow history rule.

- [ ] **Step 4: Run focused tests and static checks**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='currency clarification|currency-only correction'`, then `pnpm typecheck` and `git diff --check`.

Expected: tests pass and both static commands exit with code 0.

- [ ] **Step 5: Commit**

Run `git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/ai/prompts/money-normalization.system.md apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && git commit -m "fix: resolve currency clarification before workflow"`.

## Self-review

- Spec coverage: Task 1 prevents two simultaneous questions; Task 2 handles `долларов` after `10 тысяч сом, верно?` and emits the NBKR conversion before progressing.
- Placeholder scan: no TBD/TODO or unspecified behavior remains.
- Type consistency: uses existing `NormalizedMoneyValue`, `ApplicationFacts`, `resolveNormalizedMoneyFacts`, and `currencyConversions` interfaces.
