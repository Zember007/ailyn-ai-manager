# Residence-Before-Pricing Prompt Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the loan agent requests residence before any client-facing amount or limit, preserves a preselected program, and presents only the server-calculated limit for that program.

**Architecture:** Keep pricing calculation on the server as the single numerical authority. Align the global prompt and the application-stage prompt so both enforce the same gate: all vehicle facts and client residence must be known before `pricing.*.publicMax` can be named or compared. Explicitly document that parking's 2,000,000 KGS value is a ceiling on the value-derived calculation, never a default offer.

**Tech Stack:** TypeScript, Markdown system prompts, Vitest.

---

### Task 1: Add the residence-before-pricing guard to the global agent prompt

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md:§3.3-§3.5`

- [ ] **Step 1: Add the explicit ordering invariant**

Add language requiring the agent, when `requestedProgram` is already set and the four base vehicle fields become known, to ask only for unknown client residence. State that it must not name, compare, or negotiate any programme limit before residence is present in `effectiveLeadCard`.

- [ ] **Step 2: Make the client-facing calculation source unambiguous**

Add language that `parking.publicMax` is the server-calculated value based on the vehicle's value and its ceiling; `2,000,000` is never a default offer or substitute for `publicMax`.

### Task 2: Mirror the guard in the active application-stage prompt

**Files:**
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts:application`

- [ ] **Step 1: Block limit messaging until residence**

Replace the current post-program limit rule with an ordered rule: after the four base fields, a preserved `requestedProgram` leads directly to the residence question; while residence is missing, do not mention `pricing`, `publicMax`, programme amounts, or the 2,000,000 KGS ceiling.

- [ ] **Step 2: Limit the post-residence response to the chosen program**

Require use of only `pricing[requestedProgram].publicMax` after residence is known. For parking, describe the 2,000,000 KGS value only as the cap of the price-based calculation, never as the amount available for a 2,000,000 KGS vehicle.

### Task 3: Verify prompt coverage and existing pricing behavior

**Files:**
- Test: `apps/api/src/dialogue/loan-pricing.spec.ts`

- [ ] **Step 1: Run the pricing tests**

Run: `pnpm --filter @ailyn/api test -- loan-pricing.spec.ts`

Expected: PASS, including the parking maximum of 990,000 KGS for a 1,999,999 KGS vehicle in Bishkek.

- [ ] **Step 2: Inspect the final prompt rules**

Run: `rg -n -i 'пропис|publicMax|стоянк|2 000 000' apps/api/src/ai/prompts/agent.system.md apps/api/src/dialogue/agent-stage-instructions.ts`

Expected: both prompt sources require residence before limit messaging and prohibit treating 2,000,000 KGS as an automatic parking offer.
