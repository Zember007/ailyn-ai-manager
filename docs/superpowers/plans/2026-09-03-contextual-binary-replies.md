# Contextual Binary Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist an unambiguous positive or negative client answer to the active question even when the answer uses natural, abbreviated wording.

**Architecture:** RouterAI remains the primary semantic interpreter of contextual answers. The extraction prompt explicitly requires meaning-based classification rather than a fixed vocabulary. A deliberately narrow TypeScript reconciliation guard prevents the family-status question from repeating if the configured model drops an unmistakable one-word negative reply.

**Tech Stack:** NestJS, TypeScript, Vitest, RouterAI JSON mode.

---

### Task 1: Define and test the regression

**Files:**

- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: Add a configured-model regression case**

Mock a schema-valid RouterAI response with no facts. Pass `не` and `нет` with `dialogueContext.pendingFacts: ["familyStatus"]`. Assert both results include `{ key: "familyStatus", value: "single" }` and neither includes `married`.

- [ ] **Step 2: Run the focused case before the implementation**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

Expected: FAIL because the configured-model reconciliation currently only recognizes expanded descriptions of being unmarried.

### Task 2: Interpret the active binary question by meaning

**Files:**

- Modify: `apps/api/src/ai/prompts/extraction.system.md`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: State the prompt invariant**

Tell RouterAI that `pendingFacts` provides the current question’s meaning and that it must map a contextual confirmation or refusal by semantic intent, rather than an allow-list of words such as `да` and `нет`. Keep unresolved answers as clarification candidates.

- [ ] **Step 2: Add the bounded dropped-fact guard**

When `familyStatus` (or its owner variant) is the only active semantic question and RouterAI omitted that fact, map an unambiguous standalone negative reply to `single`. Do not use the guard for a message containing additional content or for an unrelated pending field.

- [ ] **Step 3: Run focused verification**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

Expected: PASS, including the new short-negative regression cases and existing family-status cases.
