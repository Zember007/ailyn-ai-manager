# Premature Visit Stage Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a programme selection from advancing an incomplete loan application to a visit question.

**Architecture:** Preserve the model's programme choice and other extracted facts, then evaluate the effective lead card at the response boundary. If the reply asks for a visit while a foundational application field or the client's residence is absent, replace only that reply with the first missing-field question, set the matching collection state, and clear `targetEvent`.

**Tech Stack:** TypeScript, NestJS, Vitest, existing `ApplicationFacts` and `AgentTurnResult` contracts.

---

### Task 1: Specify the observed programme-to-visit regression

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:326-380`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write the failing regression test**

```ts
it("returns to the missing vehicle value when parking selection is followed by a premature visit question", async () => {
  const client = { isConfigured: vi.fn().mockReturnValue(true), createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    ...validResult,
    reply: "Офис работает с понедельника по пятницу с 11:00 до 19:00. Для оформления нужно приехать не позднее 18:00. На какой день и время Вам удобно подъехать?",
    leadCardPatch: { requestedProgram: "parking" },
    dialogueState: { stage: "SCHEDULING_VISIT", status: "need_more_data", nextAction: "schedule_visit" },
    targetEvent: "visit"
  }) } }] }) } as any;

  const output = await new AgentTurnService(client).run({
    messages: [{ author: "ai", body: "Можем рассмотреть программу со стоянкой — она Вам подойдёт?", createdAt: "now" } as any],
    facts: { vehicleModel: "Camry", vehicleYear: 2022, requestedAmount: 1_000_000, requestedProgram: "without_storage" } as any,
    settings: {}, text: "со стоянкой ок", attachments: []
  });

  expect(output.reply).toBe("Какая ориентировочная стоимость автомобиля?");
  expect(output.result?.leadCardPatch).toMatchObject({ requestedProgram: "parking" });
  expect(output.result?.dialogueState).toEqual({ stage: "COLLECTING_VALUE", status: "need_more_data", nextAction: "collect_vehicle_value" });
  expect(output.result?.targetEvent).toBeNull();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because the current response boundary preserves the visit question, `SCHEDULING_VISIT`, and `targetEvent: "visit"`.

### Task 2: Guard a visit question by the earliest incomplete application field

**Files:**

- Modify: `apps/api/src/dialogue/agent-turn.service.ts:294-317`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Implement the foundational prerequisite resolver**

```ts
function earliestIncompleteVisitPrerequisite(facts: ApplicationFacts): { reply: string; stage: "COLLECTING_VEHICLE" | "COLLECTING_VALUE" | "COLLECTING_AMOUNT" | "COLLECTING_RESIDENCE"; nextAction: string } | undefined {
  if (!facts.vehicleModel) return { reply: "Подскажите, пожалуйста, модель автомобиля.", stage: "COLLECTING_VEHICLE", nextAction: "collect_vehicle_model" };
  if (!facts.vehicleYear) return { reply: "Подскажите, пожалуйста, год выпуска автомобиля.", stage: "COLLECTING_VEHICLE", nextAction: "collect_vehicle_year" };
  if (facts.vehicleValue === undefined) return { reply: "Какая ориентировочная стоимость автомобиля?", stage: "COLLECTING_VALUE", nextAction: "collect_vehicle_value" };
  if (facts.requestedAmount === undefined) return { reply: "Какая сумма займа Вам необходима?", stage: "COLLECTING_AMOUNT", nextAction: "collect_requested_amount" };
  if (!facts.requestedProgram) return { reply: "Подскажите, пожалуйста, Вас интересует займ без изъятия автомобиля или с постановкой автомобиля на охраняемую стоянку?", stage: "COLLECTING_VEHICLE", nextAction: "collect_program" };
  if (!facts.residenceRegion || !facts.residenceCategory) return { reply: "Где Вы прописаны — Бишкек, Чуйская область или другой регион Кыргызстана?", stage: "COLLECTING_RESIDENCE", nextAction: "collect_residence" };
  return undefined;
}
```

- [ ] **Step 2: Detect only a real visit prompt**

```ts
function isVisitQuestion(reply: string): boolean {
  return /на\s+какой\s+день\s+и\s+время\s+вам\s+удобно\s+(?:подъехать|приехать)|(?:на\s+какой|какой)\s+(?:день|дат[уы]).{0,80}(?:подъехать|приехать)|(?:когда|во\s+сколько)\s+вам\s+удобно\s+(?:подъехать|приехать)/iu.test(reply);
}
```

- [ ] **Step 3: Apply the guard in `finalizeAgentPayload`**

```ts
const visitPrerequisite = isVisitQuestion(parsed.reply)
  ? earliestIncompleteVisitPrerequisite(effectiveFacts)
  : undefined;

return {
  ...parsed,
  dialogueState: visitPrerequisite
    ? { stage: visitPrerequisite.stage, status: "need_more_data", nextAction: visitPrerequisite.nextAction }
    : parsed.dialogueState,
  targetEvent: visitPrerequisite ? null : parsed.targetEvent,
  reply: visitPrerequisite ? visitPrerequisite.reply : existingReplySelection
};
```

Keep the existing guarantor, region-10, maximum-loan, greeting, knowledge, and office-hours guards as the `existingReplySelection` branch. The new guard must not alter a reply that does not ask to schedule a visit.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; the programme changes to `parking`, while the response asks for vehicle value and does not create a visit event.

### Task 3: Verify the stage guard in the dirty working tree

**Files:**

- Modify: only `apps/api/src/dialogue/agent-turn.service.ts` and `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Review changes without disturbing existing work**

Run: `git diff --check && git diff -- apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors; existing uncommitted guarantor and money/limit fixes remain intact.

- [ ] **Step 2: Run the full test suite and static checks**

Run: `pnpm test && pnpm typecheck && pnpm lint && git diff --check`

Expected: the full Vitest suite, TypeScript checks, ESLint, and whitespace check pass.

- [ ] **Step 3: Do not commit**

Run: `git status --short`

Expected: leave the user's existing changes and this fix uncommitted, because the task does not authorise a commit and the current `main` worktree is already dirty.

## Self-review

- The regression test reproduces the supplied transition: incomplete card → parking choice → incorrectly proposed visit.
- The guard keeps the valid programme selection but makes the earliest missing foundation field authoritative for the next reply.
- It only runs for a recognisable visit question, so non-visit model responses continue through the existing dialogue boundaries.
- It clears both the stage and `targetEvent`, preventing the orchestrator from notifying a manager about an invalid visit.
