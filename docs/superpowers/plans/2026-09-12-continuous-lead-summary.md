# Continuous Lead Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the private lead summary after every persisted fact update and constrain it to concise, staff-useful final facts.

**Architecture:** The orchestrator invokes the existing summary model after a turn changes lead-card facts, rather than once after a visit. The store overwrites the latest summary atomically on each refresh. The summary prompt makes facts authoritative and bans internal statuses, document-side detail, promises, qualifiers, and office address.

**Tech Stack:** TypeScript, NestJS, Prisma, RouterAI JSON mode, Vitest.

---

### Task 1: Make summary persistence refreshable

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:310-340`
- Modify: `apps/api/src/dialogue/stage1-store.service.ts:387-409`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Write a failing test that updates facts before a visit**

```ts
expect(agent.summarizeDialogue).toHaveBeenCalledWith(expect.objectContaining({
  facts: expect.objectContaining({ vehicleModel: "Corolla" })
}));
expect(store.saveDialogueSummary).toHaveBeenCalledWith("app", "Авто: Corolla 2022.");
```

- [x] **Step 2: Replace the post-booking gate**

Call the summary method whenever `changedFactKeys.length > 0`, after the outgoing reply is stored. Remove the `visitBooked`, `!dialogueSummary`, and one-time claim gate. Save the newly generated non-empty summary by overwriting the existing value.

- [x] **Step 3: Verify the focused test**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "refreshes the private summary"`

Expected: PASS.

### Task 2: Constrain summary wording

**Files:**
- Modify: `apps/api/src/ai/prompts/dialogue-summary.system.md`
- Test: `apps/api/src/dialogue/agent-turn.service.spec.ts` or `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Add a prompt-contract test**

```ts
expect(summaryPrompt).toContain("Не используйте слова «ориентировочная», «подтверждён», «single»");
expect(summaryPrompt).toContain("Не указывайте адрес офиса");
```

- [x] **Step 2: State exact inclusion rules in the prompt**

Use only final facts. Render family status humanly, guarantor as `есть`/`нет`, documents as broad categories without sides, and photos as `получены`/`не отправлены`; omit non-final states. Do not describe programme applicability, promises, internal enum labels, or office address.

- [x] **Step 3: Verify focused tests and typecheck**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "refreshes the private summary|summary prompt" && pnpm typecheck`

Expected: PASS.
