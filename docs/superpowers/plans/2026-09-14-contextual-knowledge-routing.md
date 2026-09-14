# Contextual Knowledge Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer a short follow-up question from the approved policy that Ailyn stated immediately before it, without allowing unrelated knowledge to compete.

**Architecture:** At the knowledge boundary, derive a server-owned `contextualPolicy` only when the last Ailyn message expresses a known terminal policy and the new client message is a short follow-up question. Pass that policy and its approved answer to the knowledge model as a high-priority, closed context. The model classifies whether the new question continues that policy; the server accepts its answer only for that branch, while ordinary questions keep the existing corpus retrieval path.

**Tech Stack:** TypeScript, NestJS dialogue service, Vitest, JSON-mode RouterAI models.

---

### Task 1: Capture the prior terminal policy at the knowledge boundary

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing regression test**

```ts
const output = await service.answerWithKnowledge({
  messages: [{ author: "ai", body: "К сожалению, автомобили с регионом 10 мы не принимаем в залог.", createdAt: "now" } as any],
  facts: { vehicleRegistrationRegion: "10" }, settings: {}, text: "так что делать", workflowFollowUp: ""
});
expect(output?.reply).toContain("другой автомобиль");
expect(output?.reply).not.toMatch(/15\s*лет/iu);
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'contextual region 10'`

Expected: FAIL because the knowledge context has no constrained prior-policy branch.

- [ ] **Step 3: Add `contextualPolicyFromHistory`**

```ts
function contextualPolicyFromHistory(messages: Stage1Message[], text: string) {
  const lastAssistant = [...messages].reverse().find((message) => message.author === "ai")?.body ?? "";
  if (isShortFollowUpQuestion(text) && /регион(?:ом)?\s+10.*не принимаем/iu.test(lastAssistant)) {
    return {
      key: "region_10_refusal",
      approvedAnswer: "По автомобилям с регионом 10 компания займ не оформляет. Если у Вас есть другой автомобиль, можете написать его модель, год выпуска, примерную стоимость и нужную сумму займа."
    };
  }
  return undefined;
}
```

Include this object in the knowledge-model context. Do not set it for a new factual question with its own subject.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'contextual region 10'`

Expected: PASS.

### Task 2: Make contextual-policy selection explicit to the knowledge model

**Files:**
- Modify: `apps/api/src/ai/prompts/knowledge-agent.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Extend the regression fixture with a competing irrelevant chunk**

```ts
expect(JSON.parse(client.createChatCompletion.mock.calls[0][0].messages[1].content).contextualPolicy)
  .toMatchObject({ key: "region_10_refusal" });
```

- [ ] **Step 2: Require branch classification in the knowledge prompt**

Add a rule: when `contextualPolicy` is passed, first decide whether the current short question asks what the previous policy means, why it applies, or what to do next. If yes, use only `contextualPolicy.approvedAnswer`, set `answerFound=true`, and do not use facts from any other corpus entry. If no, ignore `contextualPolicy` and answer the current new question normally.

- [ ] **Step 3: Run the contextual regression**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'contextual region 10'`

Expected: PASS and no `15 лет` phrase.

### Task 3: Verify ordinary KB routing remains open for new questions

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a regression for a new question after a refusal**

```ts
expect(context.contextualPolicy).toBeUndefined();
```

Use `"какая ставка?"` after a region-10 refusal; it must be treated as a new rate question, not as a continuation of the refusal.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'contextual region 10|new rate question after refusal'`

Expected: PASS.

- [ ] **Step 3: Run static verification**

Run: `pnpm typecheck && git diff --check`

Expected: both commands exit 0.
