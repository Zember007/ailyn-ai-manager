# Money Intent and Limit Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a loan request separate from vehicle value, and answer a maximum-loan question with either the missing calculation inputs or server-calculated ranges for both programmes—never interest rates.

**Architecture:** The turn-local money normalizer remains the primary interpreter, but a deterministic explicit-role check rejects a conflicting duplicate role for a single amount. Documentation retrieval supplies rate guidance only to actual interest-rate questions. A small reply boundary enforces the incomplete-data branch for a maximum-loan query, preventing an LLM/retrieval regression from exposing rates or uncalculated limits.

**Tech Stack:** TypeScript, NestJS, Vitest, existing `resolveMoneyFacts` parser and `LoanPricing` context.

---

### Task 1: Stop global rate guidance from competing with limit questions

**Files:**

- Modify: `apps/api/src/dialogue/documentation-retrieval.ts:14-23`
- Modify: `apps/api/src/ai/prompts/agent.system.md:216-229`
- Test: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] **Step 1: Write failing retrieval assertions**

```ts
it("does not supply interest-rate guidance for a maximum-loan question", () => {
  const result = selectRelevantDocumentation({
    facts: {},
    currentMessage: "сколько денег по максимуму дадите",
    messages: []
  });

  expect(result.commonKnowledge.some((chunk) => chunk.section === "5.23.1")).toBe(false);
});

it("supplies interest-rate guidance for an actual rate question", () => {
  const result = selectRelevantDocumentation({ facts: {}, currentMessage: "какая процентная ставка", messages: [] });
  expect(result.commonKnowledge.some((chunk) => chunk.section === "5.23.1")).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and confirm the first assertion fails**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts`

Expected: the maximum-loan assertion fails because section `5.23.1` is currently included in `commonKnowledge` on every turn.

- [ ] **Step 3: Gate section 5.23.1 on explicit interest language**

Replace the unconditional fifth item in `commonKnowledge` with a condition calculated from `input.currentMessage`:

```ts
const currentQuestion = (input.currentMessage ?? "").toLocaleLowerCase("ru-RU");
const asksInterestRate = /(?:процент|ставк)/u.test(currentQuestion);
const commonKnowledge = [
  findChunk((chunk) => chunk.section === "5.1"),
  findChunk((chunk) => chunk.section === "5.25"),
  findChunk((chunk) => chunk.text.includes("Я Айлин — виртуальный помощник")),
  findChunk((chunk) => /осмотр.*5 минут|5 минут.*осмотр/u.test(chunk.text)),
  ...(asksInterestRate ? [findChunk((chunk) => chunk.section === "5.23.1")] : [])
].filter((chunk): chunk is DocumentationChunk => Boolean(chunk));
```

At the start of prompt section 6, add this precedence rule:

```md
Вопрос о деньгах/лимите и вопрос о процентной ставке — разные темы. Ставку, 2,4%, парковку 130 сом в сутки, индивидуальную ставку после осмотра и FAQ о ставках разрешено сообщать только когда клиент прямо спрашивает о процентах/ставке. На вопрос «сколько денег», «сколько дадите», «какой максимум» и смысловые варианты никогда не отвечайте ставкой.

До ответа на максимальную сумму нужны: модель автомобиля, год выпуска, ориентировочная стоимость автомобиля и прописка клиента. Если хотя бы одного из них нет, не называйте диапазон, ставку, общий потолок компании или предварительный лимит. Скажите, что для расчёта по обеим программам нужны только отсутствующие данные, и перечислите их. Если все четыре факта уже есть и сервер передал доступный `publicMax`, назовите диапазоны обеих программ по правилам ниже.
```

- [ ] **Step 4: Run the retrieval test and verify it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts`

Expected: PASS; the rate chunk is absent for `сколько денег по максимуму дадите` and present for `какая процентная ставка`.

- [ ] **Step 5: Commit the isolated retrieval and prompt change**

```bash
git add apps/api/src/dialogue/documentation-retrieval.ts apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/ai/prompts/agent.system.md
git commit -m "fix: separate maximum-loan questions from interest rates"
```

### Task 2: Reject a duplicated vehicle value for one explicit loan request

**Files:**

- Modify: `apps/api/src/ai/prompts/money-normalization.system.md:7-16`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:10,61-87`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing normalizer-boundary test**

```ts
it("keeps a one-amount loan request out of vehicle value", async () => {
  const client = {
    isConfigured: vi.fn().mockReturnValue(true),
    createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ values: [
      { field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 },
      { field: "vehicleValue", amount: 1_000_000, currency: "KGS", confidence: 0.99 }
    ] }) } }] })
  } as any;

  const result = await new AgentTurnService(client).normalizeMoney({
    text: "камри 2022 г 1 млн дадите ?", facts: {}, messages: []
  });

  expect(result).toEqual([{ field: "requestedAmount", amount: 1_000_000, currency: "KGS", confidence: 0.99 }]);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because `normalizeMoney` currently trusts both LLM fields.

- [ ] **Step 3: Add the explicit-role reconciliation and prompt prohibition**

Import `resolveMoneyFacts` alongside `roundSomAmount` and apply this helper after Zod parsing, before the foreign-currency correction:

```ts
function discardConflictingSingleAmountRole(values: NormalizedMoneyValue[], text: string | undefined, facts: ApplicationFacts): NormalizedMoneyValue[] {
  const resolved = resolveMoneyFacts({ text, currentFacts: facts });
  const explicitRoles = new Set(resolved.mentions
    .filter((mention) => mention.roleCandidate !== "unknown")
    .map((mention) => mention.roleCandidate));
  if (resolved.mentions.length !== 1 || explicitRoles.size !== 1) return values;
  return values.filter((value) => explicitRoles.has(value.field));
}
```

Use it here:

```ts
return discardConflictingSingleAmountRole(parsed.data.values, input.text, input.facts).map((value) =>
  value.currency !== "KGS" && !explicitlyMentionsCurrency(input.text, value.currency)
    ? { ...value, currency: "KGS" as const }
    : value
);
```

Add this to `money-normalization.system.md` after the field definitions:

```md
- Одна сумма с явным смыслом займа (`нужно`, `надо`, `дадите`, `хочу получить`, вопрос «сколько дадите») — только `requestedAmount`. Не дублируйте её как `vehicleValue`, даже если стоимость автомобиля ещё неизвестна. `vehicleValue` возвращайте лишь при отдельно и явно названной цене/стоимости автомобиля.
```

- [ ] **Step 4: Run focused parser and service tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; the existing parser test and the new model-boundary test both preserve only `requestedAmount` for the one-value request.

- [ ] **Step 5: Commit the money-role guard**

```bash
git add apps/api/src/ai/prompts/money-normalization.system.md apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "fix: require an explicit vehicle value"
```

### Task 3: Enforce the incomplete-data response for a maximum-loan question

**Files:**

- Modify: `apps/api/src/dialogue/agent-turn.service.ts:265-305`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write a failing reply-boundary test**

```ts
it("asks for calculation inputs instead of rates for an incomplete maximum-loan question", async () => {
  const client = {
    isConfigured: vi.fn().mockReturnValue(true),
    createChatCompletion: vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
      ...validResult,
      reply: "Ставка определяется индивидуально. По стоянке 2,4% в месяц.",
      leadCardPatch: {}
    }) } }] })
  } as any;

  const output = await new AgentTurnService(client).run({
    messages: [{ author: "ai", body: "Чем могу помочь?", createdAt: "now" } as any],
    facts: {}, settings: {}, text: "сколько денег по максимуму дадите", attachments: []
  });

  expect(output.reply).toContain("Чтобы рассчитать максимум по обеим программам");
  expect(output.reply).toContain("ориентировочную стоимость автомобиля");
  expect(output.reply).toContain("где Вы прописаны");
  expect(output.reply).not.toMatch(/ставк|2,4%/iu);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because the raw model reply is currently preserved.

- [ ] **Step 3: Add a narrow reply guard before the normal reply enrichers**

Implement helpers that recognise a maximum-loan question, detect missing inputs, and build a request containing only missing information:

```ts
function maximumLoanInputRequest(input: Pick<AgentTurnInput, "text">, facts: ApplicationFacts): string | undefined {
  if (!/(?:сколько.{0,30}(?:денег|сом|дадите|выдадите|максим|лимит)|(?:максим|доступн).{0,30}(?:сумм|лимит|дать))/iu.test(input.text ?? "")) return undefined;
  const missing = [
    !facts.vehicleModel || !facts.vehicleYear ? "модель и год автомобиля" : undefined,
    !facts.vehicleValue ? "ориентировочную стоимость автомобиля" : undefined,
    !facts.residenceRegion || !facts.residenceCategory ? "где Вы прописаны — Бишкек, Чуйская область или другой регион Кыргызстана" : undefined
  ].filter((value): value is string => Boolean(value));
  return missing.length === 0 ? undefined : `Чтобы рассчитать максимум по обеим программам, напишите, пожалуйста: ${missing.join("; ")}.`;
}
```

In `finalizeAgentPayload`, calculate the existing reconciled reply once, then calculate `maximumLoanReply` and use it before `appendContinuationAfterRegion10PolicyQuestion`:

```ts
const reconciledReply = removeQuestionsForKnownLeadFacts(
  enrichVisitQuestionWithOfficeHours(
    enforceFirstContactGreeting(
      replaceUnsupportedFallbackWithApprovedAnswer(parsed.reply, mandatoryKnowledgeAnswer, input),
      input
    )
  ),
  effectiveFacts
);
const maximumLoanReply = maximumLoanInputRequest(input, effectiveFacts);

reply: guarantorDeclined
  ? "Без поручителя оформление без изъятия продолжить нельзя. Хотите продолжить по программе с постановкой автомобиля на охраняемую стоянку?"
  : maximumLoanReply
    ? maximumLoanReply
    : appendContinuationAfterRegion10PolicyQuestion(reconciledReply, input, effectiveFacts)
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; the reply asks only for calculation inputs, with no rate or parking-fee text.

- [ ] **Step 5: Commit the reply guard**

```bash
git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "fix: gate maximum-loan answers on calculation data"
```

### Task 4: Verify the complete change without overwriting existing guarantor work

**Files:**

- Modify: only the files changed in Tasks 1–3
- Test: `apps/api/src/dialogue/documentation-retrieval.spec.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Inspect the working diff before final verification**

Run: `git diff --check && git diff -- apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors; pre-existing guarantor changes remain present and unmodified except where the new adjacent guard is deliberately added.

- [ ] **Step 2: Run the targeted regression suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run static verification**

Run: `pnpm typecheck && pnpm lint && git diff --check`

Expected: all workspace type checks and linting pass, and `git diff --check` prints no errors.

- [ ] **Step 4: Commit only if the pre-existing guarantor changes are intentionally included by the user**

```bash
git status --short
```

Expected: inspect the two pre-existing guarantor edits separately. Do not include them in a commit for this task without the user's explicit direction.

## Self-review

- Task 1 removes the specific retrieval conflict that exposes rate text to a maximum-loan request, while retaining rate guidance for a direct rate question.
- Task 2 covers the observed `камри 2022 г 1 млн дадите ?` failure at both prompt and persisted-normalization boundaries.
- Task 3 guarantees the requested collect-first behavior if a model still replies with rates while required calculation facts are missing.
- A complete lead card and server `publicMax` leave Task 3 inactive, so existing section 6 remains responsible for presenting both programme ranges.
- The plan deliberately does not touch the unrelated uncommitted guarantor fix.
