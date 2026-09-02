# Turn Routing, Corrections, and Knowledge Completeness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every inbound turn preserve all accepted document results, apply explicit lead-card corrections, answer every client question from approved knowledge/documentation, and use a complete manager-contact fallback only as the last resort.

**Architecture:** Keep RouterAI as the primary turn classifier and interpreter. Harden only the deterministic orchestration contracts around its structured output: accepted attachment classifications become a turn-scoped acknowledgement list, accepted correction signals authorize currency replacement, and the complete raw question turn is always searched alongside model-extracted subquestions. Approved knowledge remains the first source, bounded documentation the second source, and a fixed contact template the final fallback.

**Tech Stack:** NestJS, TypeScript, Vitest, Prisma-backed knowledge records, RouterAI provider abstraction.

---

### Task 1: Preserve and acknowledge every accepted document in the current turn

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/response-plan.service.ts`
- Test: `apps/api/src/dialogue/response-plan.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing response-plan tests for a full and partial document batch**

Add tests that call `ResponsePlanService.build` with `receivedDocuments: ["id_front", "id_back", "vehicle_registration_front", "vehicle_registration_back"]` and assert that one exact acknowledgement names both ID sides and both registration-certificate sides. Add a second assertion proving that a later turn with `receivedDocuments: []` does not repeat the acknowledgement merely because `facts.documents` still contains received documents.

```ts
expect(plan.answers.find((answer) => answer.key === "documents_received")?.text).toBe(
  "Спасибо, получили: лицевую и обратную стороны ID, лицевую и обратную стороны свидетельства о регистрации ТС."
);
expect(laterPlan.answers.some((answer) => answer.key === "documents_received")).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm the new assertions fail**

Run: `pnpm --filter @ailyn/api test -- response-plan.service.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: FAIL because `receivedDocuments` is not yet accepted and the plan still emits only `id_front_received`.

- [ ] **Step 3: Return turn-scoped received document codes from attachment processing**

Change `processAttachments` to return `receivedDocuments: DocumentCode[]`. Add a code only when Vision mapped it to a supported document and its quality is good; deduplicate the list before returning it.

```ts
return {
  facts: mergeFacts(Object.keys(documents).length > 0 ? { documents } : {}, extractedFacts),
  hasRecognitionIssue,
  receivedDocuments: [...new Set(receivedDocuments)]
};
```

- [ ] **Step 4: Build one complete deterministic acknowledgement**

Pass `documentFacts.receivedDocuments` into `ResponsePlanService.build`. Replace the `id_front` special case with a `buildDocumentAcknowledgement(receivedDocuments)` helper that maps every accepted code to an approved client-facing label and returns one `documents_received` answer.

```ts
const documentAcknowledgement = buildDocumentAcknowledgement(input.receivedDocuments ?? []);
const specialAnswers = buildSpecialAnswers(
  input.facts,
  input.decision,
  input.questions,
  input.intents ?? [],
  input.supportPhone,
  documentAcknowledgement
);
```

- [ ] **Step 5: Run the focused tests and confirm they pass**

Run: `pnpm --filter @ailyn/api test -- response-plan.service.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: PASS with the complete current-turn acknowledgement and no stale acknowledgement on later turns.

### Task 2: Apply explicit foreign-currency corrections to an existing lead

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing regression test for `А нет нужно 6к долларов`**

Create an application with an existing converted `requestedAmount`, `requestedAmountSourceCurrency: "USD"`, and pending `requestedProgram`. Mock extraction as a `fact_update` with `intents: ["correction"]` and a `requestedAmount` USD money mention. Mock NBKR conversion and assert that `store.updateFacts` receives the new converted amount and the response plan is built without `unrecognized_reply` recovery.

```ts
expect(store.updateFacts).toHaveBeenCalledWith(
  application,
  expect.objectContaining({ requestedAmount: 524_700, requestedAmountSourceCurrency: "USD" })
);
expect(responsePlan.build).toHaveBeenCalledWith(expect.objectContaining({ recovery: undefined }));
```

- [ ] **Step 2: Run the regression test and confirm it fails**

Run: `pnpm --filter @ailyn/api test -- dialogue-orchestrator.service.spec.ts`

Expected: FAIL because `resolveForeignCurrencyFacts` currently skips a role when that role already exists.

- [ ] **Step 3: Authorize only structured correction turns to replace an existing money fact**

Derive `revisedMoneyRoles` from accepted incoming money facts, `changedFacts`, and the `correction` intent on `fact_update` or `mixed` turns. Pass the set into `resolveForeignCurrencyFacts`; permit conversion to overwrite the existing role only when that role is explicitly authorized. Keep pure `question` turns non-mutating.

```ts
const revisedMoneyRoles = getRevisedMoneyRoles({ extraction, incomingFacts, currentFacts: application.facts });
const fxResolution = await resolveForeignCurrencyFacts({
  mentions: extraction.moneyMentions,
  currentFacts: application.facts,
  incomingFacts,
  revisedMoneyRoles,
  deferredIntegrations: this.deferredIntegrations
});
```

- [ ] **Step 4: Add a non-mutation test for a hypothetical currency question**

Add a `turnKind: "question"` case containing a USD money mention and assert that an already saved `requestedAmount` is not overwritten.

- [ ] **Step 5: Run the focused tests and confirm both correction and question cases pass**

Run: `pnpm --filter @ailyn/api test -- dialogue-orchestrator.service.spec.ts`

Expected: PASS; the correction updates the lead, while the question leaves it unchanged.

### Task 3: Search the complete question turn and answer every subquestion

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/knowledge/knowledge.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/knowledge/knowledge.service.spec.ts`

- [ ] **Step 1: Write failing tests for incomplete model question extraction**

Add a `selectClientQuestions` test where RouterAI returns only `можно ли с собакой` for the raw turn `Ну есть Вайфай? И можно ли с собакой?`. Assert that the returned retrieval inputs retain both the extracted semantic question and the full raw turn. Add a knowledge test asserting the raw turn resolves both `office_wifi_charging` and `office_visitors`.

```ts
expect(questions).toEqual(expect.arrayContaining([
  { text: "Ну есть Вайфай? И можно ли с собакой?", topic: "general" },
  { text: "можно ли с собакой", topic: "office_visitors" }
]));
expect(answers.map((answer) => answer.key)).toEqual(expect.arrayContaining([
  "office_wifi_charging",
  "office_visitors"
]));
```

- [ ] **Step 2: Run focused tests and confirm the Wi-Fi half is missing**

Run: `pnpm --filter @ailyn/api test -- knowledge.service.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: FAIL because the raw turn is discarded and the approved Wi-Fi aliases do not include Cyrillic `вайфай` wording.

- [ ] **Step 3: Preserve the full raw question as a retrieval candidate**

For confirmed `question` and `mixed` turns, make `selectClientQuestions` append the trimmed raw text with topic `general` unless an extracted question already contains the complete turn. Keep non-question fact updates out of retrieval.

```ts
const completeTurn = text?.trim();
return deduplicateQuestions([
  ...questions,
  ...(completeTurn ? [{ text: completeTurn, topic: "general" }] : [])
]);
```

- [ ] **Step 4: Extend approved knowledge aliases and general office answer**

Increment the relevant seed versions. Add Cyrillic Wi-Fi aliases (`вайфай`, `есть вайфай`) to `office_wifi_charging`. Add an approved `office_amenities` item for contextual questions such as `что у вас там есть` with a concise answer naming the waiting area, Wi-Fi, water/cooler, and available charging, grounded in the approved document.

```ts
{
  key: "office_amenities",
  category: "office",
  aliases: ["office_amenities", "какие удобства в офисе", "что есть в офисе", "что у вас там есть"],
  answerRu: "В офисе есть зона ожидания, Wi-Fi, вода и кулер; при необходимости поможем зарядить телефон.",
  priority: 90,
  status: "approved",
  version: 1,
  active: true
}
```

- [ ] **Step 5: Run focused tests and confirm all questions resolve**

Run: `pnpm --filter @ailyn/api test -- knowledge.service.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: PASS with both Wi-Fi and dog answers returned for the compound turn.

### Task 4: Make last-resort fallback include both manager contact channels

**Files:**
- Modify: `apps/api/src/knowledge/knowledge.service.ts`
- Test: `apps/api/src/knowledge/knowledge.service.spec.ts`
- Test: `apps/api/src/dialogue/knowledge-base-resolver.service.spec.ts`

- [ ] **Step 1: Write a failing fallback contract test**

Resolve a genuinely unknown question and assert the blocked fallback contains both the manager phone and WhatsApp number.

```ts
expect(answer.text).toContain("+996 502 108 108");
expect(answer.text).toContain("WhatsApp +996 776 108 108");
expect(answer.blocked).toBe(true);
```

- [ ] **Step 2: Run the fallback tests and confirm they fail**

Run: `pnpm --filter @ailyn/api test -- knowledge.service.spec.ts knowledge-base-resolver.service.spec.ts`

Expected: FAIL because `unknown_fallback` currently tells the client to contact a manager without contact details.

- [ ] **Step 3: Update the versioned fallback seed**

Increment `unknown_fallback` to version 3 and use the approved last-resort template.

```ts
answerRu: "К сожалению, у меня нет достоверной информации по этому вопросу. Пожалуйста, позвоните менеджеру по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108 — сотрудники подскажут Вам.",
version: 3
```

- [ ] **Step 4: Run the focused fallback tests and confirm they pass**

Run: `pnpm --filter @ailyn/api test -- knowledge.service.spec.ts knowledge-base-resolver.service.spec.ts`

Expected: PASS with the complete deterministic fallback.

### Task 5: Verify the complete Stage 1 workflow and deliver

**Files:**
- Modify if needed: `docs/superpowers/plans/2026-09-02-turn-routing-corrections-and-knowledge.md`

- [ ] **Step 1: Run all local verification gates**

Run:

```bash
pnpm typecheck
pnpm test
pnpm test:scenarios
pnpm build
```

Expected: all commands exit 0; blocked scenarios remain `BLOCKED` rather than being rewritten.

- [ ] **Step 2: Run the affected workflow in Docker and inspect logs**

Start the relevant services with the repository's `compose.yml`, exercise document upload, amount correction, compound office questions, and unknown fallback through the Web Test Channel, then inspect API/Admin/PostgreSQL/Redis logs for exceptions, validation fallbacks, or persistence errors.

Expected: all four conversations persist the expected facts and answers, with no new error log entries.

- [ ] **Step 3: Review the final diff against the requirements**

Run: `git diff --check && git diff --stat && git status --short`

Expected: no whitespace errors, only scoped source/test/plan changes, and no secrets or `.env` files.

- [ ] **Step 4: Commit and push the finished block**

Run:

```bash
git add apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/response-plan.service.ts apps/api/src/dialogue/response-plan.service.spec.ts apps/api/src/knowledge/knowledge.service.ts apps/api/src/knowledge/knowledge.service.spec.ts apps/api/src/dialogue/knowledge-base-resolver.service.spec.ts docs/superpowers/plans/2026-09-02-turn-routing-corrections-and-knowledge.md
git commit -m "fix: preserve client corrections and complete answers"
git push origin main
```

Expected: commit succeeds on `main` and push updates `origin/main`.

CI/CD and deployment checks are intentionally excluded from this delivery at the user's request.
