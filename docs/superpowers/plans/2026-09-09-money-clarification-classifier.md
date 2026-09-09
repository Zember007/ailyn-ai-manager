# Money Clarification Classifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use a dedicated model to resolve agreement, rejection, or an explicit currency after a monetary confirmation question.

**Architecture:** `AgentTurnService` will expose a classifier for the active `10 тысяч сом, верно?` step and return `accept`, `reject`, or a foreign currency. `DialogueOrchestratorService` will run that classifier before money normalisation, use its currency as the source of truth for the pending amount, and pass a rejection marker to the turn service so it emits the canonical re-entry question.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Add classifier regressions

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing tests**

Mock a classifier decision `currency: "USD"` for client text `долларов` after `10 тысяч сом, верно?`; assert conversion uses `10_000 USD`. Mock `decision: "reject"` for `нет`; assert the reply is exactly `Тогда уточните, какую сумму вы имели в виду?` and no programme question is appended.

- [ ] **Step 2: Run the focused tests**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='money clarification classifier'`.

Expected: FAIL because the current path has no dedicated decision request and treats rejection as an ordinary reply.

### Task 2: Make the classifier model-owned

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/ai/prompts/money-normalization.system.md`

- [ ] **Step 1: Implement the classifier**

Add `classifyPendingMoneyClarification` to `AgentTurnService`. Send the last AI clarification and client reply to RouterAI with strict JSON `{ "decision":"accept"|"reject"|"undecided", "currency":"USD"|"EUR"|"KZT"|"RUB"|null }`. Currency must be emitted only when the client explicitly names it. Use the classifier currency to create the pending `NormalizedMoneyValue`; retain deterministic detection only when the classifier is unavailable or undecided.

- [ ] **Step 2: Implement rejection output**

Pass the classifier rejection into `AgentTurnService.run` and, while the last AI message is a money confirmation, replace the reply with `Тогда уточните, какую сумму вы имели в виду?`. Do not append the workflow follow-up.

- [ ] **Step 3: Run verification**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='money clarification classifier|currency clarification|currency-only correction'`, `pnpm typecheck`, and `git diff --check`.

Expected: all focused tests pass and static checks exit with code 0.

- [ ] **Step 4: Commit**

Run `git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/ai/prompts/money-normalization.system.md && git commit -m "fix: classify money clarification replies"`.

## Self-review

- Spec coverage: model determines agreement, rejection, and explicit currency; server emits the required rejection wording and preserves one-question ordering.
- Placeholder scan: no TBD/TODO remains.
- Type consistency: uses existing `NormalizedMoneyValue`, `ForeignMoneyCurrencyCode`, and `AgentTurnInput` interfaces.
