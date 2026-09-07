# Knowledge Agent Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the main loan-flow model compact and route atypical or unsupported questions to a separately configured knowledge model with the complete approved document corpus.

**Architecture:** The main model emits a transient `leadCardPatch.knowledgeRequest` routing object and retains responsibility for extracting application facts and choosing the next workflow action. The orchestrator calls a dedicated knowledge-answer method only when that object requires a lookup; the knowledge model receives the whole approved corpus and returns the final client reply, while its routing metadata is stripped before persistence.

**Tech Stack:** NestJS, TypeScript, Zod, RouterAI chat completions, Vitest.

---

### Task 1: Define the transient routing contract and model configuration

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts`
- Modify: `packages/config/src/index.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a failing test proving an atypical question launches the knowledge path only when `leadCardPatch.knowledgeRequest.required` is true.**

```ts
leadCardPatch: {
  knowledgeRequest: { required: true, reason: "missing_approved_answer" }
}
expect(agent.answerWithKnowledge).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Add the Zod-only transient metadata and configuration field.**

```ts
knowledgeRequest: z.object({
  required: z.boolean(),
  reason: z.enum(["atypical_question", "missing_approved_answer", "out_of_scope"]).optional()
}).optional()
```

```ts
routerAiKnowledgeModel?: string;
routerAiKnowledgeModel: optionalEnv("ROUTERAI_KNOWLEDGE_MODEL"),
```

- [ ] **Step 3: Verify the targeted test now reaches the new routing boundary.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the pre-existing suite remains green after the mock is updated.

### Task 2: Create a knowledge-only answer path with the complete corpus

**Files:**
- Create: `apps/api/src/ai/prompts/knowledge-agent.system.md`
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Export one function that exposes all approved document chunks to the knowledge model.**

```ts
export function allApprovedKnowledge() {
  return [...generatedDocumentationChunks, ...approvedFaqChunks];
}
```

- [ ] **Step 2: Add a concise knowledge-agent prompt and a structured response schema.**

```ts
const knowledgeAnswerSchema = z.object({
  reply: z.string().min(1).max(4000),
  answerFound: z.boolean()
});
```

The prompt must require a direct approved answer when found and an explicit, honest client-facing statement that the question is outside the approved information when no answer exists.

- [ ] **Step 3: Implement `AgentTurnService.answerWithKnowledge`.**

```ts
const response = await this.client.createChatCompletion({
  model: this.config.routerAiKnowledgeModel ?? this.config.routerAiTextModel,
  messages: [
    { role: "system", content: loadPrompt("knowledge-agent.system.md") },
    { role: "user", content: JSON.stringify({ currentMessage, history, facts, workflowFollowUp, knowledge: allApprovedKnowledge() }) }
  ]
});
```

- [ ] **Step 4: Verify the knowledge request uses the separate configured model and full corpus.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the test observes `ROUTERAI_KNOWLEDGE_MODEL` and all chunks in the knowledge-agent request.

### Task 3: Route safely and prevent metadata persistence

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Call `answerWithKnowledge` after a valid main-agent result requests lookup.**

```ts
const knowledgeRequest = turn.result?.leadCardPatch.knowledgeRequest;
if (knowledgeRequest?.required) {
  const knowledge = await this.agent.answerWithKnowledge({ ... });
  turn = { ...turn, reply: knowledge.reply, result: { ...turn.result, reply: knowledge.reply } };
}
```

- [ ] **Step 2: Strip `knowledgeRequest` before reconciliation and persistence.**

```ts
const { knowledgeRequest: _knowledgeRequest, ...leadCardPatch } = turn.result.leadCardPatch;
```

- [ ] **Step 3: Verify a routing request cannot become a durable client-card field.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: `store.updateFacts` receives application facts but not `knowledgeRequest`.

### Task 4: Compact the main model instructions and context

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Replace the long main prompt with concise requirements.**

Keep role/language, fact extraction, money-role ambiguity, semantic short replies, stage-completion visit gate, server-pricing authority, one-next-question discipline, JSON contract, and `knowledgeRequest` routing. Remove the document FAQ corpus and long operational copies because the knowledge model owns them.

- [ ] **Step 2: Cap normal-path retrieval to two stage chunks and omit the full common-knowledge payload.**

```ts
const retrieval = selectRelevantDocumentation({ ...input, maxChunks: 2 });
const context = { ..., stageInstructions: retrieval.stageInstructions, knowledge: retrieval.knowledge };
```

- [ ] **Step 3: Verify the main call remains compact and its knowledge-routing request remains valid.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the main context has at most two knowledge chunks; routing and standard application turns pass.

### Task 5: Full regression verification

**Files:**
- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`

- [ ] **Step 1: Run dialogue regression tests.**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: all selected tests pass.

- [ ] **Step 2: Run the API type checker and whitespace validation.**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: both commands exit with code 0.

- [ ] **Step 3: Do not commit automatically.**

The worktree contains existing user changes; leave integration/commit ownership with the user.
