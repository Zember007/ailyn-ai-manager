# Contextual Money Role Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a bare money reply inherit the field requested by the immediately preceding direct assistant question.

**Architecture:** The main agent prompt, active application-stage instruction, and money-normalizer prompt use the same precedence rule. A direct question for vehicle value makes a short answer such as «сумма 2 млн» `vehicleValue`; explicit loan-intent language remains `requestedAmount`; genuinely unbound values remain unresolved.

**Tech Stack:** Markdown prompts, TypeScript template strings, Vitest.

---

### Task 1: Define contextual priority in all monetary prompts

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md:1.1.1`
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts:application`
- Modify: `apps/api/src/ai/prompts/money-normalization.system.md:money role rules`

- [ ] **Step 1: Add the exact conversation rule**

Add: when the last direct assistant question asks for the car's estimated value, a short numeric answer including «сумма» is `vehicleValue`; when it asks for the desired loan, it is `requestedAmount`.

- [ ] **Step 2: Preserve explicit client corrections**

State that explicit phrases such as «нужен займ», «хочу получить», or «сумма займа» override the prior question. A number that is neither an answer nor explicitly labelled must not be saved.

### Task 2: Verify prompt integrity

**Files:**
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`

- [ ] **Step 1: Check the focused money normalisation suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 2: Check compilation and patch whitespace**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: both commands exit with code 0.
