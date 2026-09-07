# Maximum Loan Reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return only the current maximum-loan answer when the client asks for the maximum, without appending a stale application-stage question.

**Architecture:** `AgentTurnService` computes direct, server-authoritative limit answers separately from the next application-stage prompt. Pass the current client text into the workflow-follow-up decision and suppress the stage prompt if that text asks for a maximum loan amount. Preserve normal stage prompting for facts submitted by the client.

**Tech Stack:** TypeScript, Vitest, ESLint.

---

### Task 1: Cover a maximum-loan question without a repeated stage prompt

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:711-733`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Change the existing maximum-loan expectation to the direct answer only**

```ts
expect(output.reply).toBe("Без изъятия: от 50 000 сом до 200 000 сом\nСо стоянкой: от 50 000 сом до 1 310 000 сом");
```

- [ ] **Step 2: Run the focused test to verify the current behavior fails the new expectation**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "returns server-calculated maximums instead of repeating residence after it is known"`

Expected: FAIL because the reply currently appends `Какая сумма займа Вам необходима?`.

### Task 2: Prevent workflow injection after a current maximum-loan question

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:481,837-840`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add the current client text to `serverWorkflowFollowUp`**

```ts
const workflowFollowUp = serverWorkflowFollowUp(input.text, effectiveFacts, stageCompletion, requestedAmountLimit, selectedLimitNotice);
```

- [ ] **Step 2: Return no workflow prompt for a maximum-loan question**

```ts
function serverWorkflowFollowUp(text: string, facts: ApplicationFacts, completion: StageCompletion, amountLimitReply: string | undefined, selectedLimitNotice: string | undefined): string | undefined {
  if (asksMaximumLoan(text)) return amountLimitReply;
  if (amountLimitReply) return amountLimitReply;
  return [selectedLimitNotice, nextRequiredStageQuestion(facts, completion)].filter(Boolean).join("\n\n") || undefined;
}
```

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "returns server-calculated maximums instead of repeating residence after it is known"`

Expected: PASS with the two server-calculated maximum lines and no application-stage question.

### Task 3: Verify the repository checks

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Run the affected spec file**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`

Expected: exit code 0 with no ESLint errors.
