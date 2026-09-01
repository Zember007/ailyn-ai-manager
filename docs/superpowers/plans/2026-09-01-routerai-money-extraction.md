# RouterAI Money Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure RouterAI recognizes vehicle value and requested loan amount from a typo-filled one-line client message and does not ask for an already supplied value.

**Architecture:** Keep natural-language interpretation in the RouterAI extraction prompt and structured response. The dialogue orchestrator continues to convert foreign-currency structured mentions into KGS before deterministic loan rules and response planning; no new local phrase parser is added.

**Tech Stack:** NestJS, TypeScript, Vitest, RouterAI provider abstraction.

---

### Task 1: Specify RouterAI extraction behavior for noisy money text

**Files:**
- Modify: `apps/api/src/ai/prompts/extraction.system.md:22-26`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

- [ ] **Step 1: Write the focused prompt-contract test**

```ts
it("passes a typo-filled vehicle value and requested amount to RouterAI as one extraction task", async () => {
  await provider.extract({ text: "камри 2022 стоит 20 тфыс долларов надо 10", facts: {}, pendingFacts: ["vehicleValue", "requestedAmount"] });
  expect(client.complete).toHaveBeenCalledWith(expect.objectContaining({
    messages: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining("тфыс") })])
  }));
});
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

Expected: the test suite passes before the prompt wording change, confirming the real message reaches RouterAI unchanged.

- [ ] **Step 3: Strengthen the system prompt**

```md
- Interpret obvious typos in numeric scale and currency words from context, for example `20 тфыс долларов` means `20 000 USD`.
- For `камри 2022 стоит 20 тфыс долларов надо 10`, return a `vehicleValue` money mention of `20000 USD` and a `requestedAmount` money mention of `10000 USD`; do not leave either role as `unknown`.
```

- [ ] **Step 4: Run the focused test again**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts`

Expected: PASS.

### Task 2: Protect the end-to-end fact merge and response plan

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a regression test using RouterAI structured extraction**

```ts
ai.extract.mockResolvedValue({
  language: "ru",
  intents: ["loan_request"],
  questions: [],
  facts: [{ key: "vehicleMake", value: "Toyota" }, { key: "vehicleModel", value: "Camry" }, { key: "vehicleYear", value: 2022 }],
  moneyMentions: [
    { amount: 20, normalizedAmount: 20000, currency: "USD", roleCandidate: "vehicleValue", confidence: 0.95, start: 18, end: 34 },
    { amount: 10, normalizedAmount: 10000, currency: "USD", roleCandidate: "requestedAmount", confidence: 0.95, start: 40, end: 42 }
  ],
  changedFacts: [], attachments: [], promptInjectionDetected: false
});
```

Assert that the saved facts contain both KGS values after conversion and the response plan does not contain the question `Какая ориентировочная стоимость автомобиля?`.

- [ ] **Step 2: Run the focused regression test**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS if the structured extraction is correctly merged and converted; otherwise use the failure to fix the integration boundary without adding a text parser.

- [ ] **Step 3: Implement the smallest integration correction only if the focused test fails**

```ts
const fxResolution = await resolveForeignCurrencyFacts({
  mentions: extraction.moneyMentions,
  currentFacts: application.facts,
  incomingFacts,
  deferredIntegrations: this.deferredIntegrations
});
Object.assign(incomingFacts, fxResolution.facts);
```

Keep one money mention per role and preserve foreign-currency conversion failure as an explicit recovery state.

- [ ] **Step 4: Run full verification**

Run: `pnpm test && pnpm typecheck && pnpm build`

Expected: all commands exit with code 0.
