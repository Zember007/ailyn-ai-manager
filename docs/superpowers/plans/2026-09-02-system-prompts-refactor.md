# Ailyn Stage 1 System Prompts Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor Stage 1 extraction, response, and vision prompts while synchronizing their structured contracts so RouterAI interprets language and TypeScript remains the sole business-decision authority.

**Architecture:** Preserve the `RouterAI extraction → deterministic dialogue/business rules → RouterAI response` pipeline. Replace model-generated money offsets with deterministic Unicode-safe occurrence reconciliation, represent unknown currencies as `null`, and use composable extraction signals rather than `turnKind` as an exclusive routing gate. Make response-plan content explicitly locked or semantic so the generator can write naturally without changing business meaning.

**Tech Stack:** NestJS, TypeScript, Zod, Vitest, pnpm workspace, RouterAI OpenAI-compatible structured JSON.

---

## File structure

- Modify `apps/api/src/ai/prompts/core.system.md`: concise authority hierarchy and untrusted-input boundary.
- Modify `apps/api/src/ai/prompts/extraction.system.md`: current-turn-only facts, nullable currency, source text only, composable signals, and mixed-turn rule.
- Modify `apps/api/src/ai/prompts/response.system.md`: locked versus semantic plan content and no artificial mixed-turn stop.
- Modify `apps/api/src/ai/prompts/response.examples.md`: plan-grounded examples without an independent business-rule knowledge base.
- Modify `apps/api/src/ai/prompts/vision.system.md`: exact vision JSON contract with independent type and quality.
- Modify `apps/api/src/ai/ai-provider.interface.ts`: nullable money currency, composable extraction flags, and vision type contract.
- Modify `apps/api/src/dialogue/pipeline.contracts.ts`: matching Zod extraction/vision/response-plan contracts.
- Modify `apps/api/src/dialogue/money-normalization.ts`: nullable-currency-safe normalization and deterministic source occurrence positions.
- Modify `apps/api/src/ai/router-ai/router-ai.provider.ts`: delete required model offsets, normalize nullable currency, reconcile offsets deterministically, and retain only safe shared-currency inference.
- Modify `apps/api/src/dialogue/dialogue-orchestrator.service.ts`: consume questions/facts/intents independently; never discard a fact solely because a message has a question.
- Modify `apps/api/src/dialogue/response-plan.service.ts` and `apps/api/src/dialogue/response-validator.service.ts`: preserve exact text only for locked items and validate semantic next-fact actions without requiring a literal question string.
- Modify relevant `*.spec.ts` files under `apps/api/src/ai/router-ai/` and `apps/api/src/dialogue/`: add and update contract, currency, multi-intent, mixed-response, and vision regression coverage.

### Task 1: Establish the revised structured contracts

**Files:**
- Modify: `apps/api/src/dialogue/money-normalization.ts`
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`

- [ ] **Step 1: Write failing contract tests for currency and offsets**

Add tests asserting `currency: null` is accepted, `start`/`end` are absent from the model-facing payload, and each normalized runtime mention has deterministic positions derived from `sourceText`.

```ts
expect(extractionSchema.safeParse({ ...baseExtraction, moneyMentions: [{
  sourceText: "500к", amount: 500, normalizedAmount: 500_000, currency: null,
  roleCandidate: "requestedAmount", confidence: 0.98
}] })).toMatchObject({ success: true });
```

- [ ] **Step 2: Run the focused tests to confirm the current contract fails**

Run: `pnpm --filter @ailyn/api test -- money-normalization.spec.ts`

Expected: FAIL because the existing schema requires a currency enum and integer `start`/`end` fields.

- [ ] **Step 3: Implement nullable-currency and internal-position contracts**

Change the public money type to `MoneyCurrencyCode | null`; remove `start` and `end` from the RouterAI/Zod output object; add them only in the post-normalization runtime shape. Update FX conversion types to process only non-null, non-KGS currencies.

```ts
export type ExtractedMoneyMention = Omit<MoneyMention, "start" | "end">;
currency: z.enum(["KGS", "USD", "EUR", "KZT", "RUB"]).nullable(),
```

- [ ] **Step 4: Run focused contract tests**

Run: `pnpm --filter @ailyn/api test -- money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the contract change**

```bash
git add apps/api/src/ai/ai-provider.interface.ts apps/api/src/dialogue/pipeline.contracts.ts apps/api/src/dialogue/money-normalization.ts apps/api/src/dialogue/money-normalization.spec.ts
git commit -m "refactor: make extraction currency nullable"
```

### Task 2: Reconcile model money source text deterministically

**Files:**
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/dialogue/money-normalization.ts`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Cover Cyrillic, emoji, repeated substrings, and two identical values by asserting occurrence allocation walks the original JavaScript string from left to right and never trusts model offsets.

```ts
expect(reconcileMoneyMentionsWithText([
  { sourceText: "10", amount: 10, normalizedAmount: 10_000, currency: "USD", roleCandidate: "vehicleValue", confidence: .9 },
  { sourceText: "10", amount: 10, normalizedAmount: 10_000, currency: "USD", roleCandidate: "requestedAmount", confidence: .9 }
], "🚗 стоит 10 тыс долларов, нужно 10")).toMatchObject([
  { start: 8 }, { start: 32 }
]);
```

- [ ] **Step 2: Run provider tests to confirm failure**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts`

Expected: FAIL because model positions remain mandatory.

- [ ] **Step 3: Implement source occurrence allocation and currency rules**

Use exact source-text matching first, a whitespace/case-normalized fallback only when unambiguous, and a consumed-occurrence cursor to assign `start`/`end`. Preserve `currency: null` when the source and bounded context do not establish a currency. Infer a shared currency only between compatible, nearby mentions in one clause with one explicit currency; do not default to KGS based on geography.

```ts
const currency = parsedCurrency ?? modelMention.currency ?? null;
return { ...modelMention, currency, start, end };
```

- [ ] **Step 4: Add the required money regressions**

Add `нужно 500к` expecting `requestedAmount`, normalized `500_000`, and `currency: null`; add `камри 2022 стоит 20 тфыс долларов надо 10` expecting `20_000 USD` and `10_000 USD`.

- [ ] **Step 5: Run provider and normalization tests**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts money-normalization.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the reconciliation change**

```bash
git add apps/api/src/ai/router-ai/router-ai.provider.ts apps/api/src/dialogue/money-normalization.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/money-normalization.spec.ts
git commit -m "refactor: derive money offsets in TypeScript"
```

### Task 3: Make extraction additive and multi-intent-safe

**Files:**
- Modify: `apps/api/src/ai/prompts/extraction.system.md`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing current-turn and multi-intent tests**

Assert a state containing Toyota/Camry/2022 plus `нужно 500 тысяч сом` produces only the current requested amount. Assert `Я уже еду, машина Camry 2022, а вы до скольки работаете?` retains `on_the_way`, facts, and the question.

- [ ] **Step 2: Run focused tests to confirm failure**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: FAIL where question/control classification suppresses writable current facts or mixed semantics are lost.

- [ ] **Step 3: Implement composable routing consumption**

Keep legacy `turnKind` for compatibility and give it documented precedence only for telemetry. Add `hasFacts`, `hasQuestions`, and `hasAttachments` flags (or derive them once after validation); route/update facts from those signals and intents rather than treating `turnKind` as a mutual-exclusion gate. Permit only new/currently confirmed/corrected facts from extraction; preserve corrections in both `facts` and `changedFacts`.

```ts
const hasFacts = extraction.facts.length > 0 || extraction.moneyMentions.length > 0;
const hasQuestions = extraction.questions.length > 0;
const mayWriteMoney = hasFacts && !extraction.intents.includes("question_only");
```

- [ ] **Step 4: Update the extraction prompt**

Require `facts` to describe the present client turn only; state that context is interpretation-only; keep correction behavior; remove the instruction that defers collection after `question + fact`; document nullable currency and no offsets.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit extraction/routing changes**

```bash
git add apps/api/src/ai/prompts/extraction.system.md apps/api/src/ai/router-ai/router-ai.provider.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "refactor: preserve additive extraction semantics"
```

### Task 4: Separate locked response text from semantic next actions

**Files:**
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`
- Modify: `apps/api/src/dialogue/response-plan.service.ts`
- Modify: `apps/api/src/dialogue/response-validator.service.ts`
- Modify: `apps/api/src/ai/prompts/response.system.md`
- Test: `apps/api/src/dialogue/response-validator.service.spec.ts`
- Test: `apps/api/src/dialogue/response-plan.service.spec.ts`

- [ ] **Step 1: Write failing locked-versus-semantic validation tests**

Assert a locked answer still must appear verbatim, while an allowed semantic action such as `nextFacts: ["vehicleValue", "requestedAmount"]` can be satisfied by a natural paraphrase that asks only for those fields.

- [ ] **Step 2: Run response tests to confirm failure**

Run: `pnpm --filter @ailyn/api test -- response-validator.service.spec.ts response-plan.service.spec.ts`

Expected: FAIL because every `nextQuestions` entry is currently required as an exact substring.

- [ ] **Step 3: Implement semantic action items**

Extend `ResponsePlan` with a machine-readable `nextFacts` list or `actions` union while retaining `nextQuestions` as deterministic fallback copy. Mark `answers[].exactText` only where text is truly locked. In the validator, require locked text verbatim and validate semantic requests by permitted fact/action coverage, falling back deterministically if a generated response is unsafe.

```ts
nextFacts: decision.requiredFacts.filter(isApplicationFact),
answers: [{ topic: "refusal", meaning: text, exactText: text }],
```

- [ ] **Step 4: Allow ordinary mixed turns to continue collection**

Remove `questions.length > 0` from the blanket `deferLegacyFlow` condition. Retain explicit stop behavior for complaint, pause, `on_the_way`, arrived, refusal, and other deterministic terminal actions.

- [ ] **Step 5: Update response prompt and test question-plus-fact flow**

State that locked text is verbatim-only and semantic actions may be combined naturally without new questions/facts. Add a response-plan/orchestrator test for Camry 2020 plus opening-hours question that answers the knowledge question and requests the deterministic next missing facts.

- [ ] **Step 6: Run response and orchestrator tests**

Run: `pnpm --filter @ailyn/api test -- response-validator.service.spec.ts response-plan.service.spec.ts dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit response-plan changes**

```bash
git add apps/api/src/ai/ai-provider.interface.ts apps/api/src/dialogue/pipeline.contracts.ts apps/api/src/dialogue/response-plan.service.ts apps/api/src/dialogue/response-validator.service.ts apps/api/src/ai/prompts/response.system.md apps/api/src/dialogue/response-validator.service.spec.ts apps/api/src/dialogue/response-plan.service.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "refactor: allow semantic response-plan actions"
```

### Task 5: Formalize vision and rewrite prompt examples

**Files:**
- Modify: `apps/api/src/ai/prompts/vision.system.md`
- Modify: `apps/api/src/ai/prompts/response.examples.md`
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: Write failing vision contract tests**

Assert an identifiable blurry ID becomes `{ type: "id_front", quality: "poor", extractedFacts: [] }`; assert unknown type can be poor; assert `poor_quality` is not accepted as a type.

- [ ] **Step 2: Run vision/provider tests to confirm failure**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts`

Expected: FAIL because `poor_quality` is currently an allowed type.

- [ ] **Step 3: Implement the strict vision contract**

Use the existing Stage 1 `car` type rather than inventing `vehicle_photo`; restrict types to ID, registration, car, and unknown; require independent `quality`; reject unreadable extracted facts; retain pixel/layout authority over metadata.

- [ ] **Step 4: Replace response examples with plan-grounded examples**

Provide the ten requested cases in `CLIENT_MESSAGE`, `BUSINESS_DECISION`, `RESPONSE_PLAN`, `GOOD_RESPONSE` form: first contact, fact update, question plus fact, correction, pause, complaint, on-the-way, unknown business question, several related facts, and short contextual answer. Give only facts and wording supplied by the included decision/plan and label examples as non-authoritative.

- [ ] **Step 5: Add concise core hierarchy**

Add the ordered authority list—system/security, deterministic decision, response plan, approved knowledge/settings, untrusted client input—to `core.system.md` without duplicating runtime context.

- [ ] **Step 6: Run provider tests**

Run: `pnpm --filter @ailyn/api test -- router-ai.provider.spec.ts`

Expected: PASS.

- [ ] **Step 7: Commit prompt and vision changes**

```bash
git add apps/api/src/ai/prompts/core.system.md apps/api/src/ai/prompts/vision.system.md apps/api/src/ai/prompts/response.examples.md apps/api/src/ai/ai-provider.interface.ts apps/api/src/ai/router-ai/router-ai.provider.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts
git commit -m "refactor: formalize Stage 1 prompt contracts"
```

### Task 6: Verify the Stage 1 pipeline and acceptance coverage

**Files:**
- Modify if needed: `docs/acceptance/ailyn_stage1_scenarios.md`
- Test: `apps/api/src/scenarios/scenarios.service.ts`

- [ ] **Step 1: Run the complete required verification suite**

Run:

```bash
pnpm typecheck
pnpm test
pnpm test:scenarios
pnpm build
```

Expected: all commands exit with code 0; non-blocked acceptance scenarios report `PASS` and blocked scenarios remain `BLOCKED`.

- [ ] **Step 2: Run the affected Docker workflow and inspect logs**

Run the project’s documented local Docker workflow with API, PostgreSQL, and Redis available. Send the unknown-currency, shared-currency, multi-intent, mixed question-plus-fact, and poor-quality-ID inputs through the Web Test Channel; inspect API and container logs for schema-validation fallbacks, invalid structured output, and response-validator fallback.

- [ ] **Step 3: Commit verification-only acceptance fixture updates if required**

```bash
git add docs/acceptance/ailyn_stage1_scenarios.md apps/api/src/scenarios
git commit -m "test: cover prompt contract regressions"
```

- [ ] **Step 4: Push and check CI**

```bash
git push origin main
```

Expected: GitHub CI and deployment complete successfully, or any failure is investigated and reported with its cause.

## Self-review

- Spec coverage: Tasks 1–2 cover nullable currency and deterministic offsets; Task 3 covers current-turn facts, corrections, composable intent, and mixed routing; Task 4 covers response freedom and collection after ordinary mixed turns; Task 5 covers examples, vision, and core hierarchy; Task 6 covers schemas, consumers, tests, acceptance, Docker logs, CI, and deployment.
- Placeholder scan: no TODO/TBD markers or unspecified implementation steps remain.
- Type consistency: monetary extraction is nullable until a deterministic KGS/FX path accepts it; runtime positions remain internal `MoneyMention` fields; response-plan locked text remains `exactText`, while semantic collection is represented separately.
