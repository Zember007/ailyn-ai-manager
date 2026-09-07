# Money Role Clarification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve an amount as a loan only when the client expresses loan intent, as vehicle value when it is explicitly tied to the car, and ask what it means when neither interpretation is reliable.

**Architecture:** The main dialogue model remains responsible for natural-language context, including a make/model/year immediately followed by a price. Its prompt will make ambiguity an explicit clarification path. The deterministic fallback will preserve explicit loan and price cues, with loan wording taking precedence over generic mentions of a car, but will no longer assign an unlabelled amount merely because a card field is missing.

**Tech Stack:** TypeScript, Markdown prompts, Vitest.

---

### Task 1: Lock the role-resolution contract in tests

**Files:**

- Modify: `apps/api/src/dialogue/money-normalization.spec.ts:44-99`

- [ ] **Step 1: Add focused regression cases before changing the parser**

Add the following test after the existing `дадите` regression:

```ts
it("does not guess a role for a standalone amount without a pending question", () => {
  const result = resolveMoneyFacts({ text: "1 млн", currentFacts: {} });

  expect(result.requestedAmount).toBeUndefined();
  expect(result.vehicleValue).toBeUndefined();
  expect(result.mentions).toEqual([
    expect.objectContaining({ normalizedAmount: 1_000_000, roleCandidate: "unknown" })
  ]);
});

it("keeps an explicit loan request ahead of generic car context", () => {
  const result = resolveMoneyFacts({
    text: "авто Camry 2022, 1 млн дадите?",
    currentFacts: {}
  });

  expect(result.requestedAmount).toBe(1_000_000);
  expect(result.vehicleValue).toBeUndefined();
});

it("uses an explicit price cue only for vehicle value", () => {
  const result = resolveMoneyFacts({
    text: "авто Camry 2022, стоимость 1 млн",
    currentFacts: {}
  });

  expect(result.vehicleValue).toBe(1_000_000);
  expect(result.requestedAmount).toBeUndefined();
});
```

Change the existing two-ambiguous-amount assertion to expect neither role; two bare values (`500 тыс и 1.2 млн`) have no reliable role mapping.

- [ ] **Step 2: Run the focused suite and confirm the new ambiguity assertion fails**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: FAIL because `chooseMoneyMention` currently fills `vehicleValue` first and assigns unclassified amounts by the missing-card-field fallback.

### Task 2: Remove the unlabelled-amount fallback and prioritise explicit intent

**Files:**

- Modify: `apps/api/src/dialogue/money-normalization.ts:31-37, 206-243`

- [ ] **Step 1: Separate a direct car-price cue from generic vehicle context**

Keep `vehicleCuePattern` for detecting a money-shaped phrase, then add a direct value pattern adjacent to it:

```ts
const vehicleValueCuePattern = /(стоит|стоимость|цена|оцен|рыночн)/i;
```

Update `inferMoneyRoleCandidate` so an explicit loan cue wins over generic `авто`/`машина` context, while an explicit value cue still identifies a price:

```ts
function inferMoneyRoleCandidate(contextBefore: string, contextAfter: string): MoneyRoleCandidate {
  const before = contextBefore.toLocaleLowerCase("ru-RU");
  const after = contextAfter.toLocaleLowerCase("ru-RU");
  const requestedScore = cueScore(before, after, requestedCuePattern);
  const vehicleValueScore = cueScore(before, after, vehicleValueCuePattern);
  const vehicleContextScore = cueScore(before, after, vehicleCuePattern);

  if (requestedScore > 0 && vehicleValueScore === 0) return "requestedAmount";
  if (vehicleValueScore > 0 && requestedScore === 0) return "vehicleValue";
  if (requestedScore > vehicleValueScore) return "requestedAmount";
  if (vehicleValueScore > requestedScore) return "vehicleValue";
  return vehicleContextScore > 0 ? "vehicleValue" : "unknown";
}
```

- [ ] **Step 2: Require a pending direct question before using an unknown amount**

Replace the one-item unknown branch in `chooseMoneyMention` with:

```ts
if (available.length === 1 && available[0].roleCandidate === "unknown") {
  return context.pendingRole === role ? available[0] : undefined;
}
```

Delete the `available.length >= 2` larger-as-value/smaller-as-requested fallback. It supplies a role from magnitude rather than client meaning.

- [ ] **Step 3: Run the focused suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts`

Expected: PASS, including the pre-existing `камри 2022 г 1 млн дадите?` case and the new no-guess cases.

### Task 3: Make ambiguity a client-facing clarification path

**Files:**

- Modify: `apps/api/src/ai/prompts/money-normalization.system.md:9-21`
- Modify: `apps/api/src/ai/prompts/agent.system.md:147-155`
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts:3`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add role precedence to both model prompts**

In the money-normalizer prompt, add these rules directly after the field definitions:

```md
- Явное намерение займа (`нужно`, `надо`, `займ`, `хочу получить`, `дайте`, `выдайте`, `дадите`) означает только `requestedAmount`, даже если рядом названы автомобиль, марка, модель или год.
- Явная цена (`стоит`, `стоимость`, `цена`, `оценка`) и сумма, которую клиент связывает с только что названными маркой, моделью и годом автомобиля, означают `vehicleValue`, если нет явного намерения займа.
- Если сумма не связана уверенно ни с ценой автомобиля, ни с желаемым займом, не возвращайте её в `values`. Не выбирайте роль по величине числа, порядку полей в карточке или тому, какое поле ещё пусто.
```

In the main dialogue prompt and the application-stage instruction, add the mirrored behaviour: when a monetary phrase cannot be confidently tied to either role, do not put it into `leadCardPatch`, set `hasMoney=false`, and ask exactly one short question: `Подскажите, это ориентировочная стоимость автомобиля или желаемая сумма займа?`

- [ ] **Step 2: Add the integration regression**

Add a mocked `AgentTurnService`/orchestrator case where the agent receives `1 млн`, returns the clarification reply and `{ hasMoney: false, leadCardPatch: {} }`. Assert that neither `vehicleValue` nor `requestedAmount` is persisted. Keep the test's mocked normalizer empty so the deterministic supplement is exercised.

- [ ] **Step 3: Run the prompt and persistence regression suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; an unbound amount does not update either card field and the documented clarification remains available to the conversation model.

### Task 4: Verify the change without absorbing unrelated worktree edits

**Files:**

- Modify: only the files in Tasks 1–3
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Inspect the relevant diff and whitespace**

Run: `git diff --check && git diff -- apps/api/src/dialogue/money-normalization.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/ai/prompts/money-normalization.system.md apps/api/src/ai/prompts/agent.system.md apps/api/src/dialogue/agent-stage-instructions.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors; unrelated uncommitted changes remain intact.

- [ ] **Step 2: Run static verification**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: both commands exit with code 0.

- [ ] **Step 3: Do not commit the shared dirty worktree**

Run: `git status --short`

Expected: report the verified changes and preserve all pre-existing modifications unless the user explicitly asks for a commit.

## Self-review

- Explicit loan wording, including `дадите`, cannot become a vehicle value merely because a car is also mentioned.
- Explicit price wording and a car-context price remain `vehicleValue`.
- A naked one-value or two-value message cannot be resolved from the missing fields or relative magnitudes; the dialogue prompt asks one direct clarification instead.
- The LLM normalizer can still apply richer make/model/year context, while the deterministic fallback is deliberately conservative and never overrides abstention with a guess.
