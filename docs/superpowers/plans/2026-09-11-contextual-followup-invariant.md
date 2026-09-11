# Contextual Follow-Up Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure contextual acknowledgement prose never suppresses the server-owned next workflow question.

**Architecture:** `contextualAcknowledgement` remains a response prefix only. The server ignores its `resumeWorkflow` flag when deriving the next required stage, so all workflow continuation stays owned by `serverWorkflowFollowUp`.

**Tech Stack:** TypeScript, Vitest.

---

### Task 1: Preserve follow-up after contextual prose

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Change the refusal regression to require the canonical visit question**

```ts
expect(output.reply).toContain("запись пока не будем оформлять");
expect(output.reply).toContain("На какой день и время");
```

- [ ] **Step 2: Run it and observe the current suppression failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "explicit refusal to book"`

Expected: FAIL because `resumeWorkflow=false` returns no server follow-up.

- [ ] **Step 3: Remove `contextualAcknowledgement.resumeWorkflow` from the follow-up suppression condition**

```ts
const workflowFollowUp = accidentNotDrivableNotice || /* existing server-only suppression cases */
  ? undefined
  : serverWorkflowFollowUp(...);
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm typecheck && pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual acknowledgement|explicit refusal to book|а зачем тебе"`

Expected: PASS.
