# Maximum-Amount Choice and Residence Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interpret «максимальная» and «по максимуму» as a request for the available maximum, and prevent amount replies from creating an ungrounded residence clarification.

**Architecture:** Keep limit calculation server-owned. A short maximum-choice reply becomes a deterministic intent that returns the currently available program maximum when a program and vehicle value are known, or asks only for the missing residence when it is not. Residence state is accepted only from explicit locality text or a reply to an actual residence question; model prose and an unrelated amount answer cannot set `residenceNeedsClarification`.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Recognize a requested maximum as a loan-amount choice

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1009-1041,1191-1205`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing regression tests**

Add tests for `максимальная` and `по максимуму` after the agent has vehicle data, value, and `requestedProgram="without_storage"` but no residence. The reply must state the server-calculated maximum for that selected program when the pricing is available, must not ask for an arbitrary amount again, and must ask only for the residence when it is still required for a region-dependent maximum.

```ts
expect(output.reply).toContain("По программе без изъятия доступно до 600 000 сом.");
expect(output.reply).not.toContain("Какая сумма займа Вам необходима?");
expect(output.reply).toContain("Вашу прописку");
```

- [ ] **Step 2: Run the named maximum-choice tests and confirm they fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='maximum-choice'`

Expected: FAIL because the current regex only recognizes questions about the maximum and server workflow repeats the amount prompt.

- [ ] **Step 3: Add a distinct maximum-choice helper and deterministic reply**

Introduce `requestsMaximumLoanAmount(text)` for bare forms such as `максимальная`, `максимум`, `по максимуму`, and `максимальную сумму`. Keep it separate from `asksMaximumLoan`, which identifies a question about potential limits. In `serverWorkflowFollowUp`, use this intent before `nextRequiredStageQuestion`: show the selected program's `publicMax` when pricing is available, otherwise explain that residence is needed and append only the residence question. Do not persist a made-up `requestedAmount`.

- [ ] **Step 4: Run the named maximum-choice tests and confirm they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='maximum-choice'`

Expected: PASS.

### Task 2: Reject residence clarification not grounded in client locality input

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:650-715,1313-1369`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing amount-after-maximum regression test**

Simulate the dialogue state with vehicle, value, selected program, no residence, and the prior question `Какая сумма займа Вам необходима?`. Return a model patch that incorrectly contains `residenceNeedsClarification=true`, then send `800 тыс`. Assert that the stored requested amount is `800_000`, that all residence fields remain unset, and that the reply requests the general residence rather than `это в Чуйской области?`.

```ts
expect(output.result?.leadCardPatch).toMatchObject({ requestedAmount: 800_000 });
expect(output.result?.leadCardPatch.residenceNeedsClarification).toBeUndefined();
expect(output.reply).toContain("Вашу прописку");
expect(output.reply).not.toContain("это в Чуйской области?");
```

- [ ] **Step 2: Run the named residence-guard test and confirm it fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='residence guard'`

Expected: FAIL because a model-supplied residence-clarification field can reach the effective lead facts despite the client only giving an amount.

- [ ] **Step 3: Make residence changes deterministic**

Exclude `residenceText`, `residenceRegion`, `residenceCategory`, and `residenceNeedsClarification` from the model patch before reconciliation. Merge back only `residencePatchFromExplicitClientText`, which permits a locality, residence keywords, or an answer to the actual Chuy clarification. Preserve an existing resolved residence when the current client turn has no residence content.

- [ ] **Step 4: Run the named residence-guard test and confirm it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='residence guard'`

Expected: PASS.

### Task 3: Verify both dialogue regressions

**Files:**
- Verify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Verify: `apps/api/src/dialogue/agent-turn.service.ts`

- [ ] **Step 1: Run both named regression groups**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='maximum-choice|residence guard'`

Expected: PASS.

- [ ] **Step 2: Type-check the workspace**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check && git diff -- apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors and only the intended deterministic routing plus tests.
