# Server-Owned Dialogue Transitions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make residence, maximum-loan selection, stage completion, and every active binary response deterministic and server-owned.

**Architecture:** Replace the persisted `requestedMaximumAmount` application fact with an agent-state `pendingAction` used only to remember the server question awaiting a reply. Normalize each client turn into independent parts—explicit fact corrections, an answer to the active action, and an optional customer question—then derive the next stage exclusively from reconciled facts. All active binary actions use a narrowly scoped semantic model classifier; regexes remain outage fallbacks only.

**Tech Stack:** TypeScript, NestJS, Zod, Vitest, RouterAI JSON-mode classifiers.

---

### Task 1: Canonical residence invariant

**Files:**
- Modify: `packages/business-rules/src/index.ts:36-135`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts:6-59`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

- [ ] **Step 1: Write failing reconciliation tests**

```ts
it("closes residence when region and category are already canonical", () => {
  const facts = effectiveFactsForTurn({
    previous: { residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", residenceNeedsClarification: true },
    modelPatch: { residenceText: "нет", residenceNeedsClarification: true },
    explicitFacts: {}, currencyFacts: {}, attachmentFacts: {}
  });
  expect(facts).toMatchObject({ residenceText: "Бишкек", residenceNeedsClarification: false });
  expect(deriveStageCompletion({ ...facts, vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "without_storage" })).toMatchObject({ residence: true, guarantor: true, documents: true });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: the new test fails because a bare negative response can survive as `residenceText` and `residenceNeedsClarification=true` blocks completion.

- [ ] **Step 3: Make residence reconciliation atomic**

In `effectiveFactsForTurn`, preserve a prior canonical residence when the current patch has no resolvable locality. Whenever `residenceRegion` and `residenceCategory` are both present, force `residenceNeedsClarification=false`. Remove `residenceNeedsClarification` from the `deriveStageCompletion` condition so completion depends on the canonical pair only.

```ts
const hasResolvedResidence = Boolean(result.residenceRegion && result.residenceCategory);
if (hasResolvedResidence) result.residenceNeedsClarification = false;
const residence = program && hasResolvedResidence;
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

Expected: all reconciliation tests pass.

### Task 2: Remove maximum preference from application facts

**Files:**
- Modify: `packages/business-rules/src/index.ts:80-90`
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts:11-16`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:930-1060,1421-1460,1544-1589`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:190-205`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:2290-2525`

- [ ] **Step 1: Replace maximum-preference tests with quote-selection tests**

```ts
it("keeps a maximum-loan question out of lead facts until the client selects a programme", async () => {
  const output = await new AgentTurnService(client).run({
    messages: [],
    facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" },
    settings: {}, text: "сколько максимум дадите?", attachments: []
  });
  expect(output.result?.leadCardPatch).not.toHaveProperty("requestedMaximumAmount");
  expect(output.result?.leadCardPatch.requestedProgram).toBeUndefined();
  expect(output.result?.leadCardPatch.requestedAmount).toBeUndefined();
  expect(output.reply).toContain("Без изъятия");
  expect(output.reply).toContain("Со стоянкой");
});
```

- [ ] **Step 2: Run the maximum-loan tests and verify they fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "maximum"`

Expected: existing preference tests fail because they expect `requestedMaximumAmount` and automatic parking selection.

- [ ] **Step 3: Add server-owned pending action for maximum quote selection**

Add a `pendingAction` enum to saved agent state, including `select_program_for_maximum`. Do not retain `requestedMaximumAmount` in `ApplicationFacts`, contracts, normalizers, or persistence. A maximum-limit question renders both calculated programme maxima and saves `select_program_for_maximum`; an explicit later programme selection writes that programme plus its matching server-calculated maximum to `requestedAmount`.

```ts
type PendingAction = "collect_residence" | "select_program" | "select_program_for_maximum" | /* existing actionable stages */;

function maximumSelectionPatch(action: PendingAction | undefined, facts: ApplicationFacts, programme: LoanProgram) {
  const pricing = calculateLoanPricing(facts, settings);
  const selected = programme === "parking" ? pricing.parking : pricing.withoutStorage;
  return selected.available ? { requestedProgram: programme, requestedAmount: selected.publicMax } : { requestedProgram: programme };
}
```

- [ ] **Step 4: Run maximum-loan tests and verify they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "maximum"`

Expected: maximum questions do not mutate lead facts; choosing a programme applies only that programme’s maximum.

### Task 3: Explicit residence updates and active-action routing

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:615-639,1933-2055,2260-2282`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:20-110,190-205`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add failing regression tests**

```ts
it("does not treat a negative answer to documents as a residence correction", async () => {
  const output = await new AgentTurnService(client).run({
    messages: [{ author: "ai", body: "Пожалуйста, отправьте фото ID и свидетельства о регистрации автомобиля с обеих сторон.", createdAt: "now" } as any],
    facts: { vehicleModel: "Camry", vehicleYear: 2022, vehicleValue: 3_000_000, requestedAmount: 600_000, requestedProgram: "without_storage", residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY" } as any,
    settings: {}, text: "нет", attachments: []
  });
  expect(output.result?.leadCardPatch).toMatchObject({ residenceText: "Бишкек", residenceRegion: "Бишкек", residenceCategory: "BISHKEK_CHUY", declinedDocuments: true });
  expect(output.reply).toContain("2–3 фотографии автомобиля");
});
```

- [ ] **Step 2: Run the new regression test and verify it fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "negative answer to documents"`

Expected: it fails before the active-action guard is introduced.

- [ ] **Step 3: Gate residence writes by action or explicit correction**

Pass the server-owned `pendingAction` into `AgentTurnService`. Permit a residence write only for `collect_residence` / `clarify_residence_chuy`, or when the current text explicitly says `прописка`, `зарегистрирован`, `регистрация`, or `сменил прописку` and contains a resolver-confirmed locality. Do not write `residenceText` from an unclassified yes/no reply.

- [ ] **Step 4: Run the regression test and verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "negative answer to documents"`

Expected: the document stage closes while residence remains canonical.

### Task 4: One semantic resolver for every active binary action

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:448-735,2021-2282,2446-2499`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add tests for semantic decisions and question separation**

```ts
it("answers a loan question without consuming the pending guarantor action", async () => {
  const output = await new AgentTurnService(client).run({
    messages: [{ author: "ai", body: GUARANTOR_REQUIREMENTS, createdAt: "now" } as any],
    facts: otherRegionWithoutStorageFacts,
    settings: {}, text: "А сколько денег дадите?", attachments: []
  });
  expect(output.result?.leadCardPatch.guarantorAvailable).toBeUndefined();
  expect(output.reply).toMatch(/до\s+[\d ]+\s+сом/u);
  expect(output.reply).toContain("У Вас есть такой поручитель?");
});

it("closes document and car-photo stages from semantic negative answers", async () => {
  // mocked classifier returns reject for `не смогу сегодня` and `фото потом`
});
```

- [ ] **Step 2: Run these tests and verify they fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "pending guarantor|semantic negative"`

Expected: stages depending solely on regexes or prose model output fail.

- [ ] **Step 3: Implement `resolvePendingAction`**

Replace the individual, partially overlapping decision paths with one dispatcher whose input is `{ pendingAction, questionAsked, clientReply }`. The classifier returns `{ decision: "accept" | "reject" | "undecided" | "not_an_answer", question: string | null }`. Add action-specific semantic prompts for `clarify_residence_chuy`, `select_program`, `select_program_for_maximum`, `limit_choice`, `guarantor_availability`, `guarantor_parking_alternative`, `documents`, `car_photo`, `office_consent`, `divorce_purchase_timing`, and `final_questions`. Keep each existing regex as the fallback only when the classifier errors or returns `undecided`; never use fallback to consume a reply classified as `not_an_answer`.

- [ ] **Step 4: Run the focused semantic-action tests and verify they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "pending guarantor|semantic negative"`

Expected: explicit questions are answered without closing binary actions; semantic negative replies close their corresponding optional stage.

### Task 5: Server-derived next action and regression suite

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:190-205`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1421-1458,1790-1850`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts:47-59`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/agent-turn-reconciliation.spec.ts`

- [ ] **Step 1: Add an end-to-end regression for the reported dialogue**

```ts
it("keeps Bishkek closed after document refusal and never opens guarantor", async () => {
  // Run: maximum question → Bishkek → choose parking or without-storage → decline documents → decline car photo.
  // Assert BISHKEK_CHUY residence completion, no guarantor prose, and ordered progression documents → car photo → family.
});
```

- [ ] **Step 2: Run the regression and verify it fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "keeps Bishkek closed"`

Expected: it fails until the orchestrator writes the server-derived pending action and rejects model-owned stage transitions.

- [ ] **Step 3: Persist only the server-derived action**

After reconciling facts, compute the earliest incomplete stage and its pending action. Persist this action in agent state, replacing any model-provided `dialogueState.stage` / `nextAction` that conflicts with facts. Build one canonical follow-up from that action after answering any separate client question.

- [ ] **Step 4: Run focused and full verification**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: both suites pass.

Run: `pnpm typecheck && pnpm lint && pnpm test`

Expected: exit code 0 for all commands.

- [ ] **Step 5: Commit**

```bash
git add packages/business-rules/src/index.ts apps/api/src/dialogue/agent-turn-reconciliation.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/agent-turn.contracts.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts docs/superpowers/plans/2026-09-09-server-owned-dialogue-transitions.md
git commit -m "fix: make dialogue transitions server-owned"
```

## Self-review

- Residence corruption is covered by Tasks 1 and 3.
- Prompt-bound binary semantic classification with regex-only fallback is covered by Task 4.
- Maximum questions no longer choose a programme, while explicit programme selection applies its matching maximum in Task 2.
- Server-owned timing, stage completion, and the reported Bishkek/guarantor regression are covered by Task 5.

### Task 6: Visit date/time precedence over money parsing

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] Add regressions for `6 октября в 6`, `6 октября в 6 вечера`, and typo `6 котября в 5` while the visit action is active.
- [ ] Parse an absolute Russian date using the current Bishkek year, rolling to the next year only when that date has already passed.
- [ ] Require the time marker `в` or an explicit hour word so the day of month cannot become the visit time.
- [ ] Suppress money-field extraction for a reply that is structurally a visit date/time response; the model must not overwrite vehicle value with a day number.
