# Divorce purchase-context protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a client marked as divorced when they answer whether the car was bought during marriage, record that purchase fact, and give only the divorce-certificate guidance.

**Architecture:** The family-stage reconciler will recognize the immediately preceding divorce purchase-timing question as a distinct semantic context. In that context it overrides any contradictory model `familyStatus` patch with the persisted `divorced` status and maps short answers such as «в браке» to `vehicleBoughtDuringMarriage=true`. A canonical server transition answer will replace model prose when divorce is first recorded, preventing duplicate consent language.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Lock the divorce purchase-timing interpretation with tests

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:1144-1157`

- [x] **Step 1: Write a regression test for the short answer «в браке» after the purchase-timing question**

```ts
const output = await service.run({
  messages: [{ author: "ai", body: divorcePurchaseQuestion, createdAt: "now" }],
  facts: { ...completeFacts, familyStatus: "divorced" },
  settings: {}, text: "в браке", attachments: []
});

expect(output.result?.leadCardPatch).toMatchObject({
  familyStatus: "divorced",
  vehicleBoughtDuringMarriage: true
});
expect(output.reply).toContain("оригинал свидетельства о расторжении брака");
expect(output.reply).not.toContain("нотариальное согласие супруга");
```

- [x] **Step 2: Add an assertion that the initial divorce answer contains one canonical no-consent statement and one purchase question**

```ts
expect(divorced.reply.match(/Нотариальное согласие бывшего супруга или супруги не требуется/g)).toHaveLength(1);
expect(divorced.reply).toContain("автомобиль был приобретён во время брака или после развода?");
```

- [x] **Step 3: Run the focused test and confirm the short-answer case fails before implementation**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "divorce"`

Expected: FAIL because the old reconciler preserves the model’s `familyStatus: "married"` or fails to set `vehicleBoughtDuringMarriage` for a short answer.

### Task 2: Make the family reconciler context-aware

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:862-902`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Identify the immediately preceding divorce purchase-timing question**

```ts
const isDivorcePurchaseTimingQuestion = (lastAssistant: string) =>
  /автомобил\p{L}*\s+был\s+приобрет\p{L}*.*(?:во\s+время\s+брака|после\s+развода)/iu.test(lastAssistant);
```

- [x] **Step 2: Preserve divorce and map the contextual short answers**

```ts
if (facts.familyStatus === "divorced" && isDivorcePurchaseTimingQuestion(lastAssistant)) {
  patch.familyStatus = "divorced";
  if (/^(?:во\s+)?браке[.!]?$/iu.test(text) || /(?:куп|приобр).{0,40}(?:во\s+)?браке/iu.test(text)) {
    patch.vehicleBoughtDuringMarriage = true;
  } else if (/после\s+развод/iu.test(text)) {
    patch.vehicleBoughtDuringMarriage = false;
  }
}
```

- [x] **Step 3: Make `familyTransitionNotice` use the same context for short answers**

```ts
if (previous.vehicleBoughtDuringMarriage !== current.vehicleBoughtDuringMarriage && current.familyStatus === "divorced" && isDivorcePurchaseTimingQuestion(lastAssistant)) {
  return current.vehicleBoughtDuringMarriage ? divorceCertificateText : divorceCertificateNotRequiredText;
}
```

- [x] **Step 4: Replace an initial model divorce acknowledgement with the one canonical server statement**

```ts
if (previous.familyStatus !== current.familyStatus && current.familyStatus === "divorced" && explicitFamilyStatus) {
  return "Нотариальное согласие бывшего супруга или супруги не требуется.";
}
```

- [x] **Step 5: Run the focused family tests**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "divorce|marital"`

Expected: PASS.

### Task 3: Verify the integration boundary

**Files:**
- Modify: `docs/superpowers/plans/2026-09-07-divorce-purchase-context.md`

- [x] **Step 1: Run typecheck and all dialogue tests that cover server reconciliation**

Run: `pnpm --filter @ailyn/api typecheck && pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: exit 0 with no failed tests.

- [x] **Step 2: Keep the shared dirty worktree uncommitted**

No commit is created: the user selected inline execution and did not ask to create one.

## Self-review

- The tests cover both reported failures: duplicate divorce messaging and accidental transition to married status.
- The implementation is limited to server-side semantic reconciliation; it does not weaken the model’s general status extraction outside the specific follow-up context.
- No broad word list changes or prompt-only mitigation is used, so the stored lead-card facts remain deterministic at the critical branch.
