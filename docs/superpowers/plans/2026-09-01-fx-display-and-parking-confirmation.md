# FX Display and Parking Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show normalized foreign-currency amounts to the client and let RouterAI use a bounded view of the active dialogue to understand contextual agreements, corrections, and returns to earlier stages before selecting an allowed next route.

**Architecture:** The orchestrator builds an AI-readable dialogue context from a compact server-owned summary plus the latest bounded messages, current facts, pending facts, and the deterministic decision envelope. RouterAI extracts facts and proposes a route (`nextFact` or `clarification`); TypeScript validates that proposal against permitted non-critical transitions and deterministic rules remain the sole source for limits, eligibility, refusals, document sufficiency, and visit admissibility. FX trace data stays verbatim for audit, but the response plan formats a normalized numeric amount and currency for client-facing text.

**Tech Stack:** NestJS, TypeScript, Vitest, RouterAI provider abstraction, deterministic business rules.

---

### Task 1: Add bounded dialogue context and an AI route proposal

**Files:**
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/dialogue/pipeline.contracts.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/ai/prompts/extraction.system.md`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Test: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing contracts and extraction tests**

```ts
expect(provider.extract).toHaveBeenCalledWith(expect.objectContaining({
  dialogueContext: expect.objectContaining({
    recentMessages: expect.arrayContaining([
      expect.objectContaining({ author: "ai", text: parkingOfferQuestion })
    ]),
    currentFacts: expect.objectContaining({ requestedProgram: "without_storage" }),
    decisionEnvelope: expect.objectContaining({ allowedNextFacts: expect.any(Array) })
  })
}));

expect(extraction.route).toEqual({ kind: "set_fact", fact: "requestedProgram", value: "parking" });
```

The fixture must include a multi-turn conversation where the client first gives vehicle data, later changes the requested amount, and finally replies `Ок` to the parking offer. Assert that the prompt receives only the recent bounded dialogue and a server-built summary—not raw unrestricted history.

- [ ] **Step 2: Run focused tests to confirm the contract is absent**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL on the missing dialogue-context and route fields.

- [ ] **Step 3: Define schema-safe context and route contracts**

```ts
type DialogueContext = {
  summary: string;
  recentMessages: Array<{ author: "client" | "ai"; text: string }>;
  currentFacts: ApplicationFacts;
  pendingFacts: Array<keyof ApplicationFacts | DocumentCode>;
  decisionEnvelope: { allowedNextFacts: string[]; activeOffer?: "parking_after_without_storage_limit" };
};

type RouteProposal =
  | { kind: "set_fact"; fact: keyof ApplicationFacts; value: unknown }
  | { kind: "clarify"; fact: keyof ApplicationFacts }
  | { kind: "none" };
```

Make the extraction schema require `route`; keep a migration adapter for old provider payloads that supplies `{ kind: "none" }`. Build `summary` from persisted facts and the last decision, and cap `recentMessages` by count and length. The service may read the complete persisted conversation, but the LLM payload must remain bounded per the project contract.

- [ ] **Step 4: Make RouterAI propose, but not execute, the next conversational route**

```md
- Read `dialogueContext` as the current conversation state. A client may answer, correct a prior fact, return to an earlier subject, or agree to the active offer.
- Return `route.kind="set_fact"` only for a client fact explicitly or contextually confirmed in this turn. If a clear agreement answers `activeOffer="parking_after_without_storage_limit"`, return `requestedProgram="parking"`.
- Never choose limits, eligibility, refusal, document sufficiency, or visit admissibility. Those are supplied only by deterministic rules.
```

Include the response JSON shape for `route` in the extraction prompt. Do not add phrase dictionaries or rules such as a local `ок` matcher.

- [ ] **Step 5: Validate route proposals before applying them**

```ts
const permitted = new Set(dialogueContext.decisionEnvelope.allowedNextFacts);
if (extraction.route.kind === "set_fact" && permitted.has(extraction.route.fact)) {
  incomingFacts[extraction.route.fact] = extraction.route.value;
}
```

Validate the candidate value using the existing facts schema, reject an invalid or non-permitted route into the normal clarification/recovery flow, and save an audit trace showing proposed versus accepted route. A fact correction to an already-known allowed fact is accepted only when RouterAI reports it in `changedFacts` with high confidence.

- [ ] **Step 6: Run focused tests**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

### Task 2: Make parking-offer confirmation a route-context case

**Files:**
- Modify: `apps/api/src/dialogue/response-plan.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing prompt-input and orchestration tests**

```ts
expect(ai.getProvider().extract).toHaveBeenCalledWith(expect.objectContaining({
  pendingConfirmation: "parking_after_without_storage_limit"
}));

expect(client.createChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
  messages: expect.arrayContaining([
    expect.objectContaining({ content: expect.stringContaining("parking_after_without_storage_limit") })
  ])
}), expect.anything());
```

Set the prior assistant message in the fixture to the exact deterministic parking-offer question and assert that an unrelated earlier message does not set this context.

- [ ] **Step 2: Run focused tests to confirm the context is absent**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL on the missing `pendingConfirmation` property.

- [ ] **Step 3: Add a bounded confirmation field and derive it only from the last assistant message**

```ts
export type PendingConfirmation = "parking_after_without_storage_limit";

export interface ExtractionInput {
  // existing fields
  pendingConfirmation?: PendingConfirmation;
}

const pendingConfirmation = lastAssistantMessage?.body === parkingOfferQuestion
  ? "parking_after_without_storage_limit"
  : undefined;
```

Use the exact existing `Если Вам нужна сумма больше лимита…` text as `parkingOfferQuestion` from one shared exported constant, so response planning and context derivation cannot drift. Do not pass unrestricted chat history.

- [ ] **Step 4: Instruct RouterAI to extract a program change from a clear agreement**

```md
- When `pendingConfirmation` is `parking_after_without_storage_limit`, a clear agreement to that immediately preceding offer (for example `ок`, `хорошо`, `да`, `продолжим`) means `facts: [{ "key": "requestedProgram", "value": "parking", "confidence": ... }]`.
- Do not set `requestedProgram` for ambiguous messages or a refusal; use `clarificationNeeded=true` if the client does not clearly answer the offer.
```

This is an AI extraction rule, not a local phrase dictionary and not a business-rule decision.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

### Task 3: Preserve contextual agreement through fact persistence and advance the flow

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add an end-to-end orchestrator regression fixture**

```ts
extract: vi.fn().mockResolvedValue({
  language: "ru",
  intents: [],
  questions: [],
  facts: [{ key: "requestedProgram", value: "parking", confidence: 0.96 }],
  moneyMentions: [],
  changedFacts: [{ key: "requestedProgram", newValue: "parking" }],
  attachments: [],
  promptInjectionDetected: false,
  clarificationNeeded: false
});
```

Start with a complete `without_storage` application whose last assistant message is the parking offer. Send each of `Ок`, `хорошо`, and `Да, продолжим с постановкой автомобиля на охраняемую стоянку` as independent cases, with RouterAI returning the structured program selection. Assert that `updateFacts` persists `requestedProgram: "parking"`, the new decision no longer exposes the parking-offer question, and the final client reply moves to the next required action.

- [ ] **Step 2: Run the regression test**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS after the structured fact merge; if it fails, fix only the fact-merge or response-plan boundary revealed by the test.

- [ ] **Step 3: Add a negative regression**

```ts
expect(ai.getProvider().extract).toHaveBeenCalledWith(expect.objectContaining({
  pendingConfirmation: undefined
}));
```

Use an application whose previous assistant message is not the parking offer. This protects unrelated `ок` replies from silently changing the programme.

- [ ] **Step 4: Re-run focused orchestration tests**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

### Task 4: Render normalized FX amounts in client-facing messages

**Files:**
- Modify: `apps/api/src/dialogue/response-plan.service.ts:380-388`
- Test: `apps/api/src/dialogue/response-plan.service.spec.ts`

- [ ] **Step 1: Write the failing response-plan test**

```ts
expect(plan.answers[0]?.text).toContain("20 000 долларов США — это ориентировочно 1 749 000 сом");
expect(plan.answers[0]?.text).toContain("10 000 долларов США — это ориентировочно 874 500 сом");
expect(plan.answers[0]?.text).not.toContain("тфыс");
```

Use `FxConversionTrace` items with the audit-only `sourceText` values `20 тфыс долларов` and `10` plus `currency: "USD"` and normalized `amount` values `20_000` and `10_000`.

- [ ] **Step 2: Run the focused response-plan test**

Run: `pnpm vitest run apps/api/src/dialogue/response-plan.service.spec.ts`

Expected: FAIL because `buildFxAnswer()` currently inserts `sourceText` verbatim.

- [ ] **Step 3: Format normalized amount and currency for the client while retaining source text in trace**

```ts
function formatForeignMoney(amount: number, currency: FxConversionTrace["currency"]): string {
  const currencyLabel = { USD: "долларов США", EUR: "евро", KZT: "тенге", RUB: "российских рублей" }[currency];
  return `${formatMoney(amount)} ${currencyLabel}`;
}

text: `По текущему курсу ${successful.map((item) =>
  `${formatForeignMoney(item.amount, item.currency)} — это ориентировочно ${formatMoney(item.somValue ?? 0)} сом`
).join(". ")}.`
```

Keep `FxConversionTrace.sourceText` unchanged in persisted metadata for auditability; it must simply never be used as client-facing copy.

- [ ] **Step 4: Run focused response-plan tests**

Run: `pnpm vitest run apps/api/src/dialogue/response-plan.service.spec.ts`

Expected: PASS.

### Task 5: Verify the corrected dialogue and repository checks

**Files:**
- Modify: `docs/verification/2026-09-01-fx-display-and-parking-confirmation.md`

- [ ] **Step 1: Run all focused dialogue tests**

Run: `pnpm vitest run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/response-plan.service.spec.ts`

Expected: PASS.

- [ ] **Step 2: Run mandatory repository checks**

Run: `pnpm test && pnpm test:scenarios && pnpm typecheck && pnpm build`

Expected: every command exits with code 0; scenario records keep legitimately blocked cases as `BLOCKED`.

- [ ] **Step 3: Run the affected Web Test Channel workflow in local Docker and inspect logs**

Run: `docker compose up -d postgres redis api admin && docker compose logs --tail=200 api admin`

Expected: services report healthy startup and no RouterAI extraction, response-validation, or persistence errors.

- [ ] **Step 4: Record evidence**

Document the exact commands, output summaries, test dialogue, and relevant Docker log observations in `docs/verification/2026-09-01-fx-display-and-parking-confirmation.md`. Do not include secrets, prompts, or chain-of-thought.

- [ ] **Step 5: Commit and push after verification**

```bash
git add apps/api/src/ai apps/api/src/dialogue docs/verification/2026-09-01-fx-display-and-parking-confirmation.md
git commit -m "fix: handle parking offer confirmation and FX wording"
git push origin main
```

Expected: a clean commit on `main`; then inspect CI and deployment status and continue debugging any failure.

## Self-review

- Spec coverage: Task 3 removes the typo from client-facing FX copy without changing extracted/audited source text. Tasks 1–2 supply RouterAI the precise prior-turn context required to interpret short agreements and persist the program transition. Task 4 validates the exact workflow plus Stage 1 regressions and Docker logs.
- Placeholder scan: no TBD/TODO or generic test instructions remain; every task includes paths, test shape, and commands.
- Type consistency: `pendingConfirmation` is an optional extraction input property and `requestedProgram: "parking"` remains an existing `ApplicationFacts` value. `FxConversionTrace.amount` and `currency` remain the source for formatted display.
