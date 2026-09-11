# Out-of-Stage Knowledge Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a reply unrelated to the active collection stage from being consumed as a stage answer, and route recognised product-policy topics to the knowledge base.

**Architecture:** The agent model will explicitly classify the current client turn relative to the last workflow question. Server code will treat that classification as the primary signal and will retain a deterministic approved-FAQ alias match as a fallback, so a known policy statement can never be hidden by stage routing. Eligibility extraction for a non-drivable post-accident vehicle will use the immediately preceding dialogue context without treating arbitrary non-drivable vehicles as accident cases.

**Tech Stack:** TypeScript, NestJS, Zod, Vitest, RouterAI JSON-mode classification.

---

### Task 1: Add an explicit model contract for stage relevance

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts`
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Write a regression using a family-status prompt followed by a vehicle-policy statement**

```ts
it("routes a non-drivable accident follow-up to knowledge instead of consuming it as family status", async () => {
  const output = await new AgentTurnService(client).run({
    messages: [{ author: "ai", body: "Автомобиль после серьёзного ДТП принимается только если он на ходу. Подскажите, пожалуйста, Ваше семейное положение — Вы в браке, в разводе или не в браке.", createdAt: "now" } as any],
    facts: completeFactsAwaitingFamilyStatus,
    settings: {}, text: "машина не находу", attachments: []
  });
  expect(output.result?.leadCardPatch.knowledgeRequest).toEqual({ required: true, reason: "missing_approved_answer" });
  expect(output.result?.leadCardPatch.familyStatus).toBeUndefined();
});
```

- [x] **Step 2: Add the optional `currentStageResponse` classifier field**

```ts
currentStageResponse: z.enum(["answer", "clarification", "unrelated"]).default("unrelated"),
```

Document that it concerns only the current user text and the final workflow question. `unrelated` must be returned for a different fact, condition, product-policy question, or a correction; in that case the model must extract the independent meaning and set `knowledgeRequest` where an answer requires approved knowledge.

- [x] **Step 3: Run the focused regression and confirm current behaviour fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "non-drivable accident follow-up"`

Expected: FAIL because stage-response routing suppresses the knowledge request.

### Task 2: Add server-owned FAQ fallback and accident-context extraction

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/documentation-retrieval.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Expose an exact approved-FAQ matcher for the current message**

```ts
export function hasExactApprovedKnowledgeMatch(text: string): boolean {
  const current = text.toLocaleLowerCase("ru-RU");
  return approvedFaqChunks.some((chunk) => hasExactApprovedFaqAlias(chunk, current));
}
```

It must match only the current client text; previous assistant messages may supply context for extraction but must never make an old FAQ look like a new user request.

- [x] **Step 2: Make stage routing reject model-marked or deterministically-known unrelated topics**

```ts
const approvedKnowledgeTopic = hasExactApprovedKnowledgeMatch(semanticText ?? "");
const stageResponse = parsed.currentStageResponse !== "unrelated" && !approvedKnowledgeTopic && /* existing active-stage checks */;
const mayNeedKnowledge = !programSelectionOnly && (approvedKnowledgeTopic || /* existing checks */);
```

When an exact FAQ alias is recognised, create `{ required: true, reason: "missing_approved_answer" }` even if the message lacks a question mark or is otherwise short. The model signal remains primary for all non-exact paraphrases; regex/FAQ matching is the fallback.

- [x] **Step 3: Preserve the post-accident non-drivable refusal fact from conversational context**

```ts
function accidentNotDrivablePatch(text: string | undefined, messages: Stage1Message[]): Partial<ApplicationFacts> {
  const currentStatesNotDrivable = /.../u.test(normalizedCurrent);
  const recentContextMentionsAccident = /.../u.test(`${normalizedCurrent} ${recentMessages}`);
  return currentStatesNotDrivable && recentContextMentionsAccident ? { accidentNotDrivable: true } : {};
}
```

Only set the fact when the current message confirms non-drivability and the current message or immediately preceding dialogue mentions an accident. Pass `input.messages` at the call site.

- [x] **Step 4: Run focused tests and confirm they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "non-drivable accident follow-up|approved knowledge match"`

Expected: PASS. The family stage remains unmodified, `accidentNotDrivable=true`, and the knowledge request is emitted.

### Task 3: Verify end-to-end knowledge precedence

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Add an orchestrator-level assertion for the knowledge-route hand-off**

```ts
expect(output.reply).toContain("принять его в залог не сможем");
expect(output.reply).not.toContain("семейное положение");
```

- [x] **Step 2: Run type and relevant suites**

Run: `pnpm typecheck && pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: typecheck and both suites pass. If unrelated pre-existing failures remain, record their exact names without changing their behaviour.
