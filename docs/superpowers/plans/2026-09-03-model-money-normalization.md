# Model Money Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove regex-based money parsing and let a structured model response normalize every client-stated money value, role and currency before the conversational agent responds.

**Architecture:** Add a narrow `normalizeMoney()` RouterAI operation that receives the complete card, history and current client message and returns only explicitly stated monetary values as `{ field, amount, currency }`. `DialogueOrchestratorService` converts those model-normalized foreign amounts through NBKR, merges the resulting KGS values into the full lead card, and then invokes the existing dialogue model with that complete updated card and the confirmed conversions. No code infers a multiplier, currency, role, spelling, case or language from the client text.

**Tech Stack:** NestJS, TypeScript, Zod, RouterAI JSON mode, NBKR deferred integration, Vitest.

---

## File map

- `apps/api/src/ai/ai-provider.interface.ts` — introduce the model-owned money-normalization input/output contract.
- `apps/api/src/ai/router-ai/router-ai.provider.ts` — implement the JSON-mode model call and remove money regex reconciliation from this provider.
- `apps/api/src/ai/prompts/money-normalization.system.md` — new narrow prompt defining numeric, currency and role semantics.
- `apps/api/src/dialogue/dialogue-orchestrator.service.ts` — call money normalization before NBKR conversion and before the conversational agent call.
- `apps/api/src/dialogue/agent-turn.service.ts` — receive only confirmed currency conversions and the completed KGS card; no raw-money parser input.
- `apps/api/src/dialogue/money-normalization.ts` — delete after all imports migrate; retain `formatMoney()` in a small formatting-only module if still needed by response-plan code.
- `apps/api/src/dialogue/money-normalization.spec.ts` — remove parser unit cases and replace them with provider/orchestrator contract tests.
- `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts` and `apps/api/src/ai/router-ai/router-ai.provider.spec.ts` — verify model normalization, conversion and dialogue input order.

### Task 1: Define a model-owned monetary contract

**Files:**

- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`
- Test: `apps/api/src/dialogue/pipeline.contracts.spec.ts`

- [ ] **Step 1: Add a failing schema test for two values in different roles.**

  Add an expected model payload that represents the original incident without preserving the original text format:

  ```ts
  const parsed = moneyNormalizationSchema.parse({
    values: [
      { field: "vehicleValue", amount: 21_000, currency: "USD", confidence: 0.99 },
      { field: "requestedAmount", amount: 10_000, currency: "USD", confidence: 0.99 }
    ]
  });
  expect(parsed.values).toHaveLength(2);
  ```

  Add a control payload with an uncertain role and assert it is rejected or represented as no value; the model must never make a guessed fact writable.

- [ ] **Step 2: Define reusable interface and Zod types.**

  In `ai-provider.interface.ts`, add:

  ```ts
  export type NormalizedMoneyValue = {
    field: "vehicleValue" | "requestedAmount";
    amount: number;
    currency: "KGS" | "USD" | "EUR" | "KZT" | "RUB";
    confidence: number;
  };

  export interface MoneyNormalizationInput {
    text: string;
    currentFacts: ApplicationFacts;
    history: Array<{ author: "client" | "ai"; text: string }>;
  }
  ```

  Define `moneyNormalizationSchema` in `pipeline.contracts.ts` with a maximum of two values, `amount > 0`, an enum currency and a confidence range of 0..1.

- [ ] **Step 3: Run the contract test.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/pipeline.contracts.spec.ts`

  Expected: PASS.

### Task 2: Implement the structured model normalizer

**Files:**

- Create: `apps/api/src/ai/prompts/money-normalization.system.md`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: Write failing provider tests.**

  Mock RouterAI JSON output for `камри 2023 стоит 21 к долларов надо 10`. Assert the provider returns both normalized values, without calling `detectMoneyMentions()`, `resolveMoneyFacts()` or any text regex fallback.

- [ ] **Step 2: Add the money-normalization prompt.**

  Require the model to:

  ```md
  Return only amounts explicitly stated by the client in the current message.
  Normalize abbreviations, word numbers, typos and supported languages to an integer amount.
  Assign vehicleValue only to vehicle price/value and requestedAmount only to desired loan amount.
  Preserve the explicitly meant currency. Do not assume KGS. If a short second amount clearly inherits the currency/unit from the same client sentence, normalize that inherited value; otherwise omit it.
  ```

- [ ] **Step 3: Implement `RouterAiProvider.normalizeMoney()`.**

  Add one `temperature: 0`, `response_format: json_object` call using the new prompt and the typed payload. Parse solely with `moneyNormalizationSchema`. On transport/format failure, return `[]` and log the failure; do not run a regex fallback.

- [ ] **Step 4: Run provider tests.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

  Expected: PASS, including the two-value USD incident.

### Task 3: Convert model-normalized foreign money before the dialogue turn

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write an orchestrator test for call order and complete card.**

  Mock the normalizer result with `$21,000` vehicle value and `$10,000` requested amount; mock NBKR at 87 som/USD and the dialogue agent. Assert that the dialogue agent receives:

  ```ts
  facts: expect.objectContaining({
    vehicleValue: 1_827_000,
    requestedAmount: 870_000,
    vehicleValueSourceCurrency: "USD",
    requestedAmountSourceCurrency: "USD"
  })
  ```

  Assert two NBKR conversions and a single dialogue-agent call. Add a control result with no model money values and assert no conversion is requested.

- [ ] **Step 2: Replace `resolveForeignCurrencyFacts(text, currentFacts, integrations)`.**

  Accept `NormalizedMoneyValue[]`, not client text. For each unique field, call NBKR only when `currency !== "KGS"`; write the converted KGS number and its source currency. For KGS, write the numeric value directly. Never inspect raw client text in this adapter.

- [ ] **Step 3: Call the normalizer in `receive()` before `AgentTurnService.run()`.**

  Supply current persisted facts and the full existing history plus the newly persisted inbound message. Merge conversion results into `inputFacts`; pass the confirmed conversion list to the dialogue model context exactly as today.

- [ ] **Step 4: Run orchestrator tests.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

  Expected: PASS; the dialogue model sees both converted values before generating its answer.

### Task 4: Remove the regex parser completely

**Files:**

- Delete: `apps/api/src/dialogue/money-normalization.ts`
- Delete: `apps/api/src/dialogue/money-normalization.spec.ts`
- Create: `apps/api/src/dialogue/money-format.ts` (only if `formatMoney()` remains required)
- Modify: `apps/api/src/dialogue/deferred-integrations.service.ts`
- Modify: `apps/api/src/dialogue/response-plan.service.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`

- [ ] **Step 1: Move only presentation formatting, if needed.**

  If response-plan code still uses `formatMoney`, create:

  ```ts
  export function formatMoney(value: number): string {
    return new Intl.NumberFormat("ru-RU").format(value).replace(/\u00a0/g, " ");
  }
  ```

  This module must contain no parser, role selection, currency detection or client-text handling.

- [ ] **Step 2: Replace all MoneyMention imports and delete parser consumers.**

  Update deferred integrations to own a local `ForeignMoneyCurrencyCode` union or import it from the model contract. Remove legacy extraction `moneyMentions` fields only after confirming the old RouterAI extraction path has no production caller; do not keep a hidden `detectMoneyMentions()` fallback.

- [ ] **Step 3: Delete the parser and its tests.**

  Delete both files only after `rg -n "money-normalization" apps packages` shows no parser imports remain. Do not replace the parser with another list of abbreviations, currencies or textual cues.

- [ ] **Step 4: Run static checks and full tests.**

  Run:

  ```bash
  pnpm --filter @ailyn/api exec tsc --noEmit
  pnpm test
  ```

  Expected: type-check passes; all tests pass.

### Task 5: Prove the original incident at the public boundary

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add an end-to-end orchestration regression.**

  Use the exact client text `камри 2023 стоит 21 к долларов надо 10`. Mock the money normalizer with its semantic JSON result, NBKR conversions and a dialogue result. Assert the persisted facts and the dialogue-agent input both contain the two converted KGS amounts, and that the reply does not ask for the loan amount again.

- [ ] **Step 2: Run the exact regression and the full suite.**

  Run:

  ```bash
  pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
  pnpm test
  ```

  Expected: both commands pass.

## Self-review

- No production path derives money meaning from client text with a regex, dictionary, locale rule or compact-number heuristic.
- The model, not server code, determines roles, multipliers and currencies.
- The dialogue model sees converted, complete lead facts before it chooses the next client-facing action.
- NBKR conversion remains server-owned and operates only on typed values returned by the model.
