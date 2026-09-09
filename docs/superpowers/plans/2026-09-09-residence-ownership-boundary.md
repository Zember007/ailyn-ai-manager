# Residence Ownership Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the main dialogue model from inventing a registration region and let the server classify only a locality explicitly supplied by the client.

**Architecture:** Strip all region/category decisions from the main-model patch. Permit its `residenceText` only as a spelling hint while the last AI message explicitly asks for registration; resolve the resulting locality through the server catalogue. Keep semantic yes/no clarification as the only separate server-owned path for a prior unresolved locality.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Reproduce the invented-region regression

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Make the main model return `residenceText: "Каракол"`, `residenceRegion: "Другой регион Кыргызстана"`, and `residenceCategory: "OTHER_KG"` for the client text `давай 200`, after a programme-selection message. Assert that the stored patch contains no residence fields and that the server asks for registration instead of guarantor details.

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='does not accept an invented residence'`

Expected: FAIL before the boundary change, because the model locality is accepted despite not occurring in the client reply.

### Task 2: Make locality collection server-owned

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Restrict normalization**

Call the locality normalizer for a non-exact phrase only when the previous AI message explicitly asks for registration. Do not call it because the model wrote a `residenceText` value during another stage.

- [ ] **Step 2: Ground the model spelling hint**

Use a model-provided `residenceText` only on the explicit registration stage. For all other messages, resolve only a locality found directly in the current client text; never use `residenceRegion`, `residenceCategory`, or `residenceNeedsClarification` from the main-model patch.

- [ ] **Step 3: Run focused tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='does not accept an invented residence|normalizes a model-reported misspelled locality|uses a second model only to stabilize a locality|accepts a plain Chuy residence answer'`

Expected: all selected tests pass.

### Task 3: Remove conflicting main-model directions

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts`

- [ ] **Step 1: State the JSON boundary**

Tell the main model it may write only the literal city or oblast mentioned by the client into `residenceText`, and only while collecting registration. Explicitly prohibit all other residence JSON fields and geographic inference.

- [ ] **Step 2: Verify static integrity**

Run: `pnpm typecheck && git diff --check`

Expected: both commands exit with code 0.

## Self-review

- Spec coverage: a city is accepted only from the client; typos can still be normalized after the explicit registration question; no ordinary turn can create `OTHER_KG` or open guarantor flow.
- Placeholder scan: no TBD/TODO remains.
- Type consistency: uses existing `ApplicationFacts`, `resolveKyrgyzstanLocality`, and semantic clarification flow.
