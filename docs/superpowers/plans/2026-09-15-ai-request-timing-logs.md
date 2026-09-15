# AI Request Timing Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log duration, requested model, and outcome for every RouterAI chat-completion request, plus one total-duration log for each dialogue turn.

**Architecture:** Keep request-level timing at `RouterAiClient`, the sole HTTP boundary for RouterAI, so every current and future caller is covered uniformly. Add turn-level timing at `DialogueOrchestratorService.receiveBatch`, whose lifecycle encompasses AI calls, storage, and preparation of the final reply.

**Tech Stack:** TypeScript, NestJS 11 Logger, Fetch API, Vitest.

---

### Task 1: Cover RouterAI request timing with a unit test

**Files:**
- Create: `apps/api/src/ai/router-ai/router-ai.client.spec.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.client.ts:14-52`

- [ ] **Step 1: Write the failing test**

```ts
it("logs the model, duration, and successful outcome for a completion", async () => {
  const spy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ choices: [] }) }));

  await new RouterAiClient().createChatCompletion({ model: "fast-model", messages: [] });

  expect(spy).toHaveBeenCalledWith("RouterAI chat completion finished", expect.objectContaining({
    event: "routerai.chat_completion",
    model: "fast-model",
    outcome: "success",
    durationMs: expect.any(Number)
  }));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.client.spec.ts`

Expected: FAIL because the client does not emit the structured timing log.

- [ ] **Step 3: Add request-boundary timing**

```ts
const startedAt = performance.now();
let outcome: "success" | "error" = "error";
try {
  // Existing fetch and response decoding.
  outcome = "success";
  return response;
} finally {
  this.logger.log("RouterAI chat completion finished", {
    event: "routerai.chat_completion",
    model: request.model,
    outcome,
    durationMs: Math.round(performance.now() - startedAt)
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.client.spec.ts`

Expected: PASS.

### Task 2: Cover whole-dialogue timing with an orchestrator test

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:30-373`

- [ ] **Step 1: Write the failing test**

```ts
it("logs total duration after a dialogue turn completes", async () => {
  const spy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  await service.receiveBatch([message]);

  expect(spy).toHaveBeenCalledWith("Dialogue turn finished", expect.objectContaining({
    event: "dialogue.turn",
    outcome: "success",
    durationMs: expect.any(Number),
    messageCount: 1
  }));
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because no `dialogue.turn` log exists.

- [ ] **Step 3: Add a `try`/`finally` around the existing `receiveBatch` body**

```ts
const startedAt = performance.now();
let outcome: "success" | "error" = "error";
try {
  // Existing method body; set outcome to success immediately before each return.
} finally {
  this.logger.log("Dialogue turn finished", {
    event: "dialogue.turn",
    outcome,
    channel: firstMessage.channel,
    conversationId: conversation?.id,
    messageCount: messages.length,
    durationMs: Math.round(performance.now() - startedAt)
  });
}
```

- [ ] **Step 4: Run focused tests and type checking**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.client.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && pnpm --filter @ailyn/api typecheck`

Expected: all selected tests and the API type check pass.

### Task 3: Verify the complete change

**Files:**
- Verify only: `apps/api/src/ai/router-ai/router-ai.client.ts`
- Verify only: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`

- [ ] **Step 1: Run lint**

Run: `pnpm eslint apps/api/src/ai/router-ai/router-ai.client.ts apps/api/src/ai/router-ai/router-ai.client.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --max-warnings=0`

Expected: PASS with no lint warnings.

- [ ] **Step 2: Inspect the diff**

Run: `git diff -- apps/api/src/ai/router-ai/router-ai.client.ts apps/api/src/ai/router-ai/router-ai.client.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: only structured observability changes and their tests.
