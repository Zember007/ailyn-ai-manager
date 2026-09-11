# Contextual Unhandled Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a brief, friendly, context-aware response to a meaningful client message that no stage, rule, calculation, or knowledge answer handled, without inventing facts or discarding the workflow.

**Architecture:** Add an ephemeral model field for a conservative contextual acknowledgement and an explicit decision to resume or pause the next workflow question. The server accepts it only in a narrow fallback gate: no knowledge lookup, no recognised fact change, no server direct answer, no calculation, and no valid stage answer. Server business rules and knowledge responses always take precedence.

**Tech Stack:** TypeScript, NestJS, Zod, Vitest, RouterAI JSON-mode classification.

---

### Task 1: Contract and prompt for safe contextual acknowledgement

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts`
- Modify: `apps/api/src/ai/prompts/agent.system.md`

- [x] **Step 1: Add an optional non-persisted acknowledgement object**

```ts
contextualAcknowledgement: z.object({
  text: z.string().min(2).max(400),
  resumeWorkflow: z.boolean()
}).strict().optional(),
```

- [x] **Step 2: Specify its strictly limited use in the prompt**

The model emits it only when the client message is meaningful but none of the current stage, a fact extraction, an approved knowledge request, a calculation, or a server policy can answer it. Its text must be brief, businesslike, friendly, and based only on the current text and history; it must not state any company rule, number, product fact, promise, or invented reason. `resumeWorkflow=false` is reserved for a clear refusal to continue the proposed visit or action.

### Task 2: Server gate and workflow preservation

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Write failing regressions**

```ts
it("keeps a friendly contextual acknowledgement before the pending visit after an unhandled reaction", async () => {
  // Model returns { contextualAcknowledgement: { text: "Понимаю, сумма может не подойти.", resumeWorkflow: true } } for "мало".
  expect(output.reply).toContain("сумма может не подойти");
  expect(output.reply).toContain("На какой день и время");
});

it("does not repeat the visit question after an explicit refusal to book", async () => {
  // Model returns resumeWorkflow=false for "не хочу запись".
  expect(output.reply).toContain("не будем");
  expect(output.reply).not.toContain("На какой день и время");
});
```

- [x] **Step 2: Accept acknowledgement only under the fallback gate**

```ts
const contextualFallback = !knowledgeRequest && !stageResponse && !hasRecognizedFactsForTurn(input.facts, effectiveFacts)
  && !directAnswer && !mandatoryKnowledgeAnswer && loanQuestionKind === "none"
  ? parsed.contextualAcknowledgement
  : undefined;
```

Use `contextualFallback.text` as the answer only after all server-owned answer sources. When `resumeWorkflow=false`, omit only the appended workflow question; do not persist a pause or mutate application facts.

- [x] **Step 3: Run focused regression tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual acknowledgement|explicit refusal to book"`

Expected: PASS. The acknowledgement is shown, but no facts, knowledge request, or fabricated policy is introduced.

### Task 3: Verify the routing boundary

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Assert that a knowledge request still wins over contextual prose**

```ts
expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
expect(output.reply).not.toContain("contextual fallback text");
```

- [x] **Step 2: Run final checks**

Run: `pnpm typecheck && pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "contextual acknowledgement|explicit refusal to book|knowledge request wins" && git diff --check`

Expected: all commands exit 0.
