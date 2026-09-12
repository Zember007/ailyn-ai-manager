# Visit Time Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirm a recognized visit time exactly once and handle an explicitly unknown time without inventing a slot.

**Architecture:** Keep deterministic time parsing as the canonical writer of `visitTime`. Add a scoped JSON semantic classifier only while the server is awaiting a visit slot; it distinguishes a time value from a client deferral. The server renders the resulting confirmation or deferral reply, so model prose cannot repeat an obsolete scheduling prompt.

**Tech Stack:** TypeScript, NestJS, Vitest, RouterAI JSON mode.

---

### Task 1: Visit-time regressions

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1686-1750,1964-2008`

- [x] **Step 1: Write failing tests**

```ts
it("confirms a colloquial time once instead of asking for it again", async () => {
  const output = await service.run({ messages: [timePrompt], facts: readyFacts, text: "приеду примерно в 5", settings, attachments: [] });
  expect(output.result?.leadCardPatch.visitTime).toBe("17:00");
  expect(output.reply).toContain("17:00");
  expect(output.reply).not.toMatch(/в какое время вам удобно/iu);
});

it("acknowledges an explicitly unknown visit time without storing one", async () => {
  const output = await service.run({ messages: [timePrompt], facts: readyFacts, text: "по времени пока не знаю", settings, attachments: [] });
  expect(output.result?.leadCardPatch.visitTime).toBeUndefined();
  expect(output.reply).toContain("сообщите, пожалуйста, когда время будет известно");
});
```

- [x] **Step 2: Run focused tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "colloquial time|unknown visit time"`

Expected: failures before the semantic deferral handling and server reply priority are added.

- [x] **Step 3: Implement scoped semantic normalization and reply priority**

Add a `resolveVisitSchedulingDecision` JSON classifier for the active scheduling question. Its output is `time_known`, `time_unknown`, or `not_a_visit_answer`. Retain deterministic parsing as the only writer for numeric time and use regex only when the classifier is unavailable/undecided. Render a time confirmation from changed visit facts before generic workflow prose; render a stable deferral message for `time_unknown` without persisting `visitTime`.

- [x] **Step 4: Verify**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "colloquial time|unknown visit time"`

Expected: both tests pass.

Run: `pnpm typecheck && pnpm lint`

Expected: exit code 0.
