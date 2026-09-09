# Narrow Money Confirmation Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the money-confirmation classifier only for an explicit confirmation of the proposed amount, never for a normal amount question following a foreign-currency vehicle price.

**Architecture:** Replace the broad “number + currency + any question” detector with a confirmation-intent detector requiring wording such as `верно`, `правильно`, or `имели в виду` near the amount. Preserve the classifier and conversion paths for actual confirmation questions.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Reproduce the false rejection

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Use the last AI message `По текущему курсу НБКР: стоимость автомобиля 27 000 долларов США — 2 360 000 сом. Какая сумма займа Вам необходима?` and client text `тысяч 10`. Assert `classifyPendingMoneyClarification` returns `undefined` and no classifier model request is made.

- [ ] **Step 2: Run the focused test**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='does not classify an ordinary amount question'`.

Expected: FAIL because the broad detector sees the vehicle price and later question as one currency clarification.

### Task 2: Narrow activation and protect confirmations

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Implement confirmation-intent detection**

Require a numeric amount and currency plus confirmation wording (`верно`, `правильно`, `имели в виду`, or `это сумма`) in the same question. Reuse that helper for classifier activation, rejection handling, workflow suppression, and history recovery.

- [ ] **Step 2: Run verification**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='does not classify an ordinary amount question|money clarification'`, `pnpm typecheck`, and `git diff --check`.

Expected: focused tests pass and static checks exit with code 0.

- [ ] **Step 3: Commit**

Run `git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && git commit -m "fix: scope money confirmation classifier"`.

## Self-review

- Spec coverage: ordinary amount collection produces a confirmation question; only the next reply to that confirmation can be classified as acceptance, rejection, or currency.
- Placeholder scan: no TBD/TODO remains.
- Type consistency: reuses existing `PendingMoneyClarificationDecision` and money normalisation paths.
