# Shared Currency for Compact Money Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert and display both foreign-currency values when the second compact amount inherits the first amount's currency in one clause.

**Architecture:** Extend the deterministic money parser's same-clause inheritance to apply currency to a second role-labelled compact amount such as `10к`. The existing orchestrator already supplements incomplete LLM output and renders every resolved conversion, so no reply-format change is needed.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Reproduce the missing second conversion

**Files:**
- Modify: `apps/api/src/dialogue/money-normalization.spec.ts`

- [ ] **Step 1: Add a compact shared-currency regression case**

Add a test for `У меня Камри за 20к долларов, а надо 10к` that expects `vehicleValue=20_000 USD` and `requestedAmount=10_000 USD`.

### Task 2: Preserve currency within a single money clause

**Files:**
- Modify: `apps/api/src/dialogue/money-normalization.ts:detectMoneyMentions`

- [ ] **Step 1: Enrich an unqualified compact amount**

When a role-labelled compact amount has no explicit currency, inherit the preceding explicit foreign currency only from the same sentence/clause and only when that preceding amount uses a thousand multiplier.

### Task 3: Verify conversion output

**Files:**
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Run focused money parsing tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run focused orchestration conversion tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the relevant conversion assertions pass; report unrelated failures separately if present.
