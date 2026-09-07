# Document extraction and stage closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a readable client full name from uploaded ID documents when possible, while treating every uploaded file as a completed optional documents stage and immediately advancing without re-asking documents, amount, or programme.

**Architecture:** Image recognition remains best-effort: the existing vision prompt and lead-card patch may write `fullName` only from readable evidence. Independently of classification or recognition success, `AgentTurnService` will place `documentsProvided=true` in the pre-reply facts whenever the client supplied an attachment; this lets server-owned stage selection move to car photos in the same response. A targeted reply guard removes stale document and confirmed-amount/programme questions from model prose.

**Tech Stack:** TypeScript, NestJS, RouterAI Vision, Vitest.

---

### Task 1: Cover attachment-stage completion before model reply

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:1740-1780`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a test where a model classifies no documents but the client sends two images**

```ts
const output = await new AgentTurnService(client).run({
  facts: completeFactsBeforeDocuments,
  messages: [{ author: "ai", body: documentQuestion, createdAt: "now" }],
  text: "",
  attachments: [{ id: "id", mimeType: "image/jpeg" }, { id: "sts", mimeType: "image/jpeg" }]
});

expect(output.result?.leadCardPatch.documentsProvided).toBe(true);
expect(output.reply).toContain("2–3 фотографии автомобиля");
expect(output.reply).not.toContain("фото ID и свидетельства");
```

- [ ] **Step 2: Include a readable name patch and assert it survives alongside stage closure**

```ts
expect(output.result?.leadCardPatch).toMatchObject({
  fullName: "Иванов Иван Иванович",
  documentsProvided: true
});
```

- [ ] **Step 3: Run the focused test before implementation**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "attachment.*documents"`

Expected: FAIL because `documentsProvided` is currently added by the orchestrator only after the model has composed its reply.

### Task 2: Close documents in the pre-reply server facts

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:421-445`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add attachment evidence to `attachmentFacts` before completion is derived**

```ts
const attachmentFacts = {
  ...attachmentFactsFromResult(input.facts, parsed.attachments),
  ...(input.attachments.length > 0 ? { documentsProvided: true } : {})
};
```

- [ ] **Step 2: Keep FIO extraction best-effort and non-blocking**

Retain `fullName` from the validated `leadCardPatch` when vision/main recognition supplies it. Do not manufacture a name, do not ask for a re-upload, and do not add a new question when it is absent.

- [ ] **Step 3: Run the focused attachment tests**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "attachment|document inventory"`

Expected: PASS.

### Task 3: Remove stale questions for completed card data

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:663-724`
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a regression test with stale model prose**

```ts
reply: "Пожалуйста, отправьте фото ID и свидетельства. У Вас всё ещё актуальна сумма 600 000 сом и программа со стоянкой?"

expect(output.reply).not.toContain("отправьте фото ID");
expect(output.reply).not.toContain("всё ещё актуальна сумма");
expect(output.reply).toContain("2–3 фотографии автомобиля");
```

- [ ] **Step 2: Remove document and confirmation questions when their facts are already known**

```ts
const withoutStaleDocumentPrompt = facts.documentsProvided
  ? reply.replace(/\s*(?:пожалуйста,?\s*)?отправьте[^.!?\n]*(?:\bid\b|паспорт|свидетельств|стс)[^.!?\n]*[?!.]?/iu, "")
  : reply;
const withoutKnownAmountProgramCheck = facts.requestedAmount !== undefined && facts.requestedProgram
  ? withoutStaleDocumentPrompt.replace(/\s*у\s+вас\s+(?:всё\s+ещё\s+)?актуальн[^?!.]*[?!.]?/iu, "")
  : withoutStaleDocumentPrompt;
```

- [ ] **Step 3: State the same non-blocking rule in the agent prompt**

Add: extract `fullName` only if visible with confidence; any upload sets the document handoff as complete; never ask again for documents or reconfirm already known amount/programme; answer a client question if present and then move to the next server-owned stage.

- [ ] **Step 4: Run typecheck and relevant dialogue suites**

Run: `pnpm --filter @ailyn/api typecheck && pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: exit 0 with no test failures.

- [ ] **Step 5: Keep the shared dirty worktree uncommitted**

The user selected inline execution and did not request a commit.

## Self-review

- The pre-reply facts close the exact race that produced a repeated document request.
- Name extraction is explicitly opportunistic, so unreadable images cannot stall the client.
- The stale-prose guard applies only when the corresponding lead-card data already exists.
