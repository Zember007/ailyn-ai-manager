# Minimum Loan Amount Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require confirmation of every requested loan amount below 50,000 som and block all later workflow stages until the amount is valid.

**Architecture:** Reuse the semantic money-confirmation classifier and the currency normalizer. The server removes a below-minimum amount from the persisted patch, sends a canonical confirmation, restores it only for a confirmed answer, and then either requests a new amount or proceeds after FX conversion.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Lock the initial amount

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`

- [ ] **Step 1: Write a regression test**

For a complete car and client amount `15 000` som, make the model propose a programme. Assert the result has no `requestedAmount` or programme and the only question is `15 000 сом, верно?`.

- [ ] **Step 2: Implement the server guard**

Before reconciliation, remove a current requested amount below `pricing.minimumLoan` and remove any programme inferred from that same turn. Produce the confirmation server-side and suppress workflow follow-ups.

### Task 2: Resolve confirmation

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Pass accept as well as reject from the semantic classifier**

Preserve the classifier decision in `AgentTurnInput` so a confirmed below-minimum som amount is recognized separately from a first submission.

- [ ] **Step 2: Assert outcomes**

For an accepted confirmation, return `Минимальная сумма займа — 50 000 сом. Назовите, пожалуйста, сумму не меньше 50 000 сом.` without persisting the invalid amount. For a foreign-currency answer, use the normalizer/converter and proceed only if the converted amount meets the minimum.

### Task 3: Verify

- [ ] **Step 1: Run focused tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='confirms a below-minimum requested amount|blocks a confirmed below-minimum amount|converts a currency correction after a below-minimum confirmation'`

- [ ] **Step 2: Run static checks**

Run: `pnpm typecheck && git diff --check`

Expected: all focused tests and static checks exit with code 0.
