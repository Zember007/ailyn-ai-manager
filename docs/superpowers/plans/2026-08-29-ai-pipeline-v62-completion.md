# Ailyn AI Pipeline 6.2 Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Stage 1 stateful AI dialogue pipeline against `AILYN_AI_PIPELINE_CODEX_PROMPT.md`, fix contextual residence capture, codify approved business limits, and verify ten RouterAI-backed end-to-end conversations locally.

**Architecture:** RouterAI remains limited to structured extraction and response wording. A deterministic fact-normalization layer reconciles model candidates with the current pending question, `packages/business-rules` owns eligibility, limits and next-action decisions, and the response planner/validator enforce exact approved content before persistence. PostgreSQL remains the durable source of dialogue state and audit history.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, RouterAI, Vitest, Docker Compose

---

### Task 1: Reproduce contextual residence loss and lock the extraction contract

**Files:**
- Create: `apps/api/src/dialogue/fact-normalizer.ts`
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add failing tests for a pending residence reply**

```ts
expect(normalizeTurnFacts({ text: "Прописка городская", pendingFacts: ["residenceRegion"], currentFacts: {} }))
  .toMatchObject({ residenceText: "городская", residenceNeedsClarification: true });
```

- [ ] **Step 2: Run the targeted tests and confirm that the current extractor repeats the generic residence question**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
Expected before implementation: at least one new residence-context assertion fails.

- [ ] **Step 3: Pass pending required facts into structured extraction and whitelist fact keys**

```ts
export interface ExtractionInput {
  text?: string;
  attachments: InboundAttachment[];
  facts: ApplicationFacts;
  pendingFacts: (keyof ApplicationFacts | DocumentCode)[];
}
```

- [ ] **Step 4: Normalize explicit and contextual residence answers without inventing a region**

```ts
export function normalizeTurnFacts(input: NormalizeTurnFactsInput): Partial<ApplicationFacts> {
  // "Бишкек" becomes BISHKEK; "городская" is retained as raw residence text
  // and causes a specific city clarification instead of repeating the same question.
}
```

- [ ] **Step 5: Run the targeted tests and confirm the residence regression passes**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
Expected: all targeted tests pass.

### Task 2: Complete deterministic business policies and next-action state

**Files:**
- Modify: `packages/business-rules/src/index.ts`
- Modify: `packages/business-rules/src/index.spec.ts`
- Modify: `apps/api/src/settings/settings.service.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add tests for approved limits, minimum amount, region 10, unsupported vehicles, owner presence, old vehicles, family consent, guarantor flow and visit cut-off**

```ts
expect(calculateLoanLimits({ vehicleValue: 2_000_000, residenceCategory: "BISHKEK" }).withoutStorage).toBe(600_000);
expect(evaluateApplication({ vehicleYear: 2000 }).status).not.toBe("refuse");
expect(evaluateApplication({ residenceCategory: "OTHER_KG", requestedProgram: "without_storage" }).nextAction).toBe("check_guarantor");
```

- [ ] **Step 2: Run business-rule tests and confirm failing cases expose current gaps**

Run: `pnpm vitest run packages/business-rules/src/index.spec.ts`
Expected before implementation: old-vehicle and configured guarantor assertions fail.

- [ ] **Step 3: Add explicit settings for approved values and unresolved conflicts**

```ts
guarantorResidencePolicy: "SPEC_CONFLICT_C1";
reminderScheduleHours: [1, 24];
officeDogPolicy: "SPEC_CONFLICT_C3";
parkingInterestRateMonthly: 2.4;
parkingDailyFeeSom: 130;
```

- [ ] **Step 4: Implement deterministic rules without converting conditional branches into refusals**

```ts
if (vehicleAge > 15) {
  eligiblePrograms = ["parking", "without_storage"];
  requiredStatements.push(OLD_VEHICLE_INDIVIDUAL_REVIEW_TEXT);
}
```

- [ ] **Step 5: Run business-rule tests and confirm all deterministic branches pass**

Run: `pnpm vitest run packages/business-rules/src/index.spec.ts`
Expected: all business-rule tests pass.

### Task 3: Complete approved knowledge, response planning and validation

**Files:**
- Modify: `apps/api/src/knowledge/knowledge.service.ts`
- Modify: `apps/api/src/dialogue/knowledge-base-resolver.service.ts`
- Modify: `apps/api/src/dialogue/response-plan.service.ts`
- Modify: `apps/api/src/dialogue/response-validator.service.ts`
- Modify: `apps/api/src/dialogue/response-plan.service.spec.ts`
- Modify: `apps/api/src/dialogue/response-validator.service.spec.ts`
- Modify: `apps/api/src/ai/prompts/extraction.system.md`
- Modify: `apps/api/src/ai/prompts/response.system.md`

- [ ] **Step 1: Add failing tests for multi-question answers, exact rate/address/document responses, no repeated known question and complete visit confirmation**

```ts
expect(plan.answers.map((answer) => answer.key)).toEqual(expect.arrayContaining([
  "without_seizure_rate", "office_location", "documents_required"
]));
expect(plan.nextQuestions.join(" ")).not.toContain("Какая прописка у собственника автомобиля?");
```

- [ ] **Step 2: Seed the approved Russian KB entries from sections 24–25 as individual keys**

```ts
{ key: "parking_rate", aliases: ["ставка по стоянке"], answerRu: "Программа со стоянкой (авто на парковке): ставка 2,4% в месяц + стоимость парковки 130 сом/сутки; сумма до 2 000 000 сом.", status: "approved" }
```

- [ ] **Step 3: Make question topic detection deterministic for compound Russian questions**

```ts
resolveQuestionTopics("Какая ставка, где офис и какие документы?")
// => ["rate", "office_location", "documents_required"]
```

- [ ] **Step 4: Build exact response plans from knowledge and rules, including a specific residence clarification**

```ts
if (facts.residenceNeedsClarification) {
  nextQuestions.push("Уточните, пожалуйста, в каком городе или области прописан собственник автомобиля?");
}
```

- [ ] **Step 5: Extend validator coverage for exact answers, all detected questions, known-fact repetition, residence wording, preliminary-limit disclaimer and five-part visit confirmation**

Run: `pnpm vitest run apps/api/src/dialogue/response-plan.service.spec.ts apps/api/src/dialogue/response-validator.service.spec.ts`
Expected: all planner and validator tests pass.

### Task 4: Persist trace, pending question and idempotent handoff state

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/stage1-store.service.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/stage1-store.service.spec.ts`

- [ ] **Step 1: Add tests proving state survives a second turn and changed facts supersede prior values**

```ts
expect(secondTurn.application.facts.residenceText).toBe("городская");
expect(secondTurn.reply).toContain("в каком городе или области");
expect(secondTurn.reply).not.toContain("Какая прописка у собственника автомобиля?");
```

- [ ] **Step 2: Reconcile extraction candidates, contextual normalizer output and attachment facts before one fact update**

```ts
const normalizedFacts = normalizeTurnFacts({ text: message.text, pendingFacts: application.decision?.requiredFacts ?? [], currentFacts: application.facts });
await store.updateFacts(application, mergeFacts(incomingFacts, normalizedFacts, documentFacts));
```

- [ ] **Step 3: Persist a structured trace with questions, facts, rules, next action, KB keys, validation and model metadata**

```ts
await store.saveTrace(application, { intents, questionsDetected, factsChanged, rulesFired, nextAction, kbKeysUsed, responseValidation });
```

- [ ] **Step 4: Emit one initial manager event and content-addressed delta events while continuing the dialogue**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/stage1-store.service.spec.ts`
Expected: all state, trace and handoff tests pass.

### Task 5: Replace superficial acceptance checks with behavioral scenario coverage

**Files:**
- Modify: `apps/api/src/scenarios/scenarios.service.ts`
- Modify: `tests/scenarios/stage1-regression.scenario.spec.ts`
- Create: `tests/scenarios/dialogue-e2e.scenario.spec.ts`

- [ ] **Step 1: Add deterministic fixtures for every non-blocked critical rule instead of source-string checks**

```ts
"S1-CAR-016": () => assertOldVehicleProgramPolicy(),
"S1-MEM-001": () => assertNoKnownFactQuestion(),
"S1-VIS-006": () => assertVisitConfirmationBlock(),
```

- [ ] **Step 2: Keep every source-marked blocked row as `BLOCKED` and report unresolved conflicts explicitly**

Run: `pnpm test:scenarios`
Expected: every non-blocked scenario passes behaviorally; every blocked source row remains BLOCKED.

- [ ] **Step 3: Add mock-provider end-to-end dialogue tests for ten full multi-turn paths**

The paths are: happy path without seizure, city residence clarification, parking maximum, region 10 refusal, unsupported vehicle, other-region guarantor, partial documents, document refusal plus visit, married consent plus visit, and active-loan redirect.

Run: `pnpm vitest run tests/scenarios/dialogue-e2e.scenario.spec.ts`
Expected: ten complete dialogue paths pass.

### Task 6: Verify ten real RouterAI conversations and the full local stack

**Files:**
- Create: `scripts/run-routerai-e2e.mjs`
- Create: `docs/verification/2026-08-29-ai-pipeline-v62-e2e.md`

- [ ] **Step 1: Start PostgreSQL, Redis, API and Admin through the local Docker workflow and apply migrations**

Run: `docker compose up -d --build`
Expected: required containers are healthy and migrations complete.

- [ ] **Step 2: Execute ten isolated Web Test Channel conversations with configured RouterAI**

Run: `node scripts/run-routerai-e2e.mjs`
Expected: 10/10 conversations satisfy their fact, decision, response and persistence assertions; no conversation uses `local-stage1-fallback`.

- [ ] **Step 3: Review API, Admin, PostgreSQL and Redis container logs for the tested window**

Run: `docker compose logs --since=20m`
Expected: no unhandled exception, migration error, response-validation leak or repeated residence question.

- [ ] **Step 4: Run the complete quality gate**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:scenarios && pnpm build`
Expected: every command exits with code 0.

- [ ] **Step 5: Record exact commands, model identifiers, scenario outcomes, blocked conflicts and log review in the verification report**

### Task 7: Review, commit, push and verify CI/deployment

**Files:**
- Modify: `docs/verification/2026-08-29-ai-pipeline-v62-e2e.md`

- [ ] **Step 1: Request an independent code review against the new specification and fix every critical/important issue**
- [ ] **Step 2: Re-run the full quality gate after review fixes**
- [ ] **Step 3: Commit with a non-interactive message**

Run: `git commit -m "feat: complete Ailyn AI pipeline 6.2"`
Expected: one reviewed commit contains only task-related changes plus the pre-existing user changes intentionally preserved.

- [ ] **Step 4: Push the branch and inspect CI/deployment results**

Run: `git push -u origin HEAD`
Expected: push succeeds; CI and deployment complete, or any external blocker is reported with exact evidence.
