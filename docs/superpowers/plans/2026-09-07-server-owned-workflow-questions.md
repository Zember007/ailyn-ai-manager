# Server-Owned Workflow Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server, rather than the language model, add exactly one canonical next application-stage question after every applicable customer-facing answer.

**Architecture:** The model remains responsible for natural-language understanding: it extracts facts, identifies a direct client question, and flags an unanswered or atypical question for the knowledge model. `AgentTurnService` is the workflow boundary: it removes any model-authored application question and appends the canonical question for the earliest incomplete server-calculated stage. The orchestrator preserves that canonical follow-up when it replaces the first-pass answer with the full knowledge-base answer.

**Tech Stack:** NestJS, TypeScript, Vitest, Zod.

---

### Task 1: Establish server-owned question behavior with tests

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

- [ ] **Step 1: Write a failing orchestration test for an ordinary client FAQ**

```ts
it("appends the earliest server-owned stage question after an ordinary FAQ answer", async () => {
  // completed vehicle facts, requestedAmount=false
  // first-pass agent reply: "Да, в офис можно приехать на такси."
  // expect: reply ends with "Какая сумма займа Вам необходима?"
});
```

- [ ] **Step 2: Write a failing orchestration test for a knowledge-base answer**

```ts
it("keeps the earliest server-owned stage question after a knowledge-model answer", async () => {
  // first-pass model sets knowledgeRequest.required=true
  // knowledge model replies only with FAQ prose
  // expect: FAQ prose followed once by the same canonical stage question
});
```

- [ ] **Step 3: Write a failing reconciliation test for a model-authored premature stage question**

```ts
it("replaces a model-authored later stage question with the canonical earliest question", () => {
  // model asks residence while requested amount is the first incomplete stage
  // expect: no residence question and exactly the canonical amount question
});
```

- [ ] **Step 4: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: the new tests fail because the system appends a follow-up only for a bare acknowledgement or office-amenities route.

### Task 2: Centralize workflow-question selection and composition

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`

- [ ] **Step 1: Add a single workflow-follow-up resolver in `agent-turn.service.ts`**

```ts
function serverWorkflowFollowUp(
  facts: ApplicationFacts,
  completion: StageCompletion,
  amountLimitReply: string | undefined
): string | undefined {
  return amountLimitReply ?? nextRequiredStageQuestion(facts, completion);
}
```

It must return the amount-limit correction question before any normal next stage, otherwise return the canonical earliest false stage.

- [ ] **Step 2: Strip model-authored application questions before appending server text**

```ts
function removeModelWorkflowQuestion(reply: string): string {
  // remove only application-collection questions (vehicle, value, amount,
  // program, residence, guarantor, documents, photos, family, and visit);
  // do not remove a direct question that is part of a factual answer.
}
```

Call it in `finalizeAgentPayload` after the existing safety/duplication guards and before calling `appendRequiredWorkflowFollowUp`.

- [ ] **Step 3: Always append the resolved server follow-up**

```ts
const workflowFollowUp = serverWorkflowFollowUp(effectiveFacts, stageCompletion, requestedAmountLimit);
const modelReply = appendRequiredWorkflowFollowUp(removeModelWorkflowQuestion(guardedReply), workflowFollowUp);
```

Keep explicit terminal/refusal/identity behavior intact and do not append a duplicate when the canonical question is already present.

- [ ] **Step 4: Preserve the canonical follow-up through the knowledge handoff**

```ts
const workflowFollowUp = extractWorkflowFollowUp(turn.reply);
const reply = appendWorkflowFollowUp(knowledge.reply, workflowFollowUp);
```

Retain the existing handoff, but verify it uses the server-produced question rather than relying on model prose.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: all focused tests pass.

### Task 3: Align the agent prompt with its narrowed responsibility

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`

- [ ] **Step 1: Replace the model instruction to ask the next stage question**

```md
Do not ask application-stage questions yourself. The server appends the only
allowed canonical next question after your reply. Your task is to understand
the client answer, update `leadCardPatch`, and answer the client's direct
question in natural language.
```

- [ ] **Step 2: State the knowledge-routing contract**

```md
If the client asks a factual question and the answer is absent from `knowledge`,
set `leadCardPatch.knowledgeRequest` to `{ "required": true, "reason":
"missing_approved_answer" }`. Do not invent an answer; the server will call
the knowledge model and append the workflow question afterward.
```

- [ ] **Step 3: Remove redundant prompt language that tells the model to select or formulate workflow questions**

Preserve instructions for fact extraction, semantic interpretation, the greeting, identity reply, and money roles. Leave the stage-completion rules only as constraints on extraction and on avoiding duplicate data requests.

### Task 4: Full verification

**Files:**
- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`
- Test: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] **Step 1: Run dialogue regression tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts`

Expected: all tests pass.

- [ ] **Step 2: Run type checking and patch validation**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: command exits with code 0.
