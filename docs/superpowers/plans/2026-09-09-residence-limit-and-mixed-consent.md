# Residence Limit Notice and Mixed Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a server-calculated programme limit immediately after an explicit residence is resolved and accept a consent prefix even when the same reply contains a new client question.

**Architecture:** Add a server-owned residence-transition reply that derives locality wording and `publicMax` from reconciled facts and pricing. Keep the main agent available to answer a simultaneous question, while the dedicated binary classifier extracts the consent decision from the same message; merge the decision before response composition so the stale offer cannot repeat.

**Tech Stack:** TypeScript, NestJS, Vitest, existing Router AI client.

---

### Task 1: Send a deterministic programme limit after a residence answer

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:741-766,1141-1165,1546-1547`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing residence-transition tests**

Add cases in which the client supplies `Каракол`, `Бишкек`, `Чуйская область`, and a parking-program residence. Assert no raw category phrase is client-visible; the reply names the correct locality context and the selected programme's server `publicMax`. For other-region, without-storage applications above the guarantor threshold, assert one combined message with the 200 000-som limit followed by `и Вам потребуется поручитель` and the full requirements.

```ts
expect(output.reply).toContain("В связи с тем, что Вы прописаны за пределами Чуйской области, по программе без изъятия Вам доступно до 200 000 сом.");
expect(output.reply).not.toContain("Каракол — это другой регион Кыргызстана");
expect(output.reply).toContain("и Вам потребуется поручитель");
```

- [ ] **Step 2: Run the named residence-limit tests and confirm they fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='residence-limit notice'`

Expected: FAIL because the model can return a category narration and the current server only emits a generic selected-limit notice after the complete application.

- [ ] **Step 3: Generate the residence-transition reply on the server**

Add a helper that runs only when this turn resolves `residenceRegion` / `residenceCategory`, has a selected programme, and has an available selected-pricing `publicMax`. Its templates are:

```ts
// OTHER_KG + without_storage
"В связи с тем, что Вы прописаны за пределами Чуйской области, по программе без изъятия Вам доступно до ${limit} сом."
// BISHKEK_CHUY + without_storage
`Для Вашей прописки в ${residenceName} по программе без изъятия Вам доступно до ${limit} сом.`
// parking
`Для Вашей прописки в ${residenceName} по программе со стоянкой Вам доступно до ${limit} сом.`
```

Use `Чуйской области` for canonical Chuy, `Бишкеке` for Bishkek, and `за пределами Чуйской области` for other regions. Replace the generic guarantor preamble with a continuation beginning `и Вам потребуется поручитель:` so the customer receives one coherent server message.

- [ ] **Step 4: Run the named residence-limit tests and confirm they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='residence-limit notice'`

Expected: PASS.

### Task 2: Handle consent and an embedded question in one client reply

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:337-340,449-487,1587-1603`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing mixed-consent tests**

Add a test for the last agent message offering parking after no guarantor and the client reply `ок. а сколько денег дадите`. Mock the main workflow model with a limit answer and mock the dedicated binary classifier with `accept`. Assert programme changes to `parking`, the answer includes the parking limit, and no clarification/repeated parking offer remains. Add the same assertion for a direct `да`.

```ts
expect(output.result?.leadCardPatch.requestedProgram).toBe("parking");
expect(output.reply).toContain("Со стоянкой: от 50 000 сом до 1 500 000 сом");
expect(output.reply).not.toContain("Уточните, пожалуйста");
```

- [ ] **Step 2: Run the named mixed-consent tests and confirm they fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='mixed parking consent'`

Expected: FAIL because the classifier currently returns `undecided` for a consent prefix plus question, leaving `unresolvedBinaryDecisionReply` to repeat the stale offer.

- [ ] **Step 3: Make the binary classifier extract consent independently of an embedded question**

Keep the existing workflow model call for the full client turn. Strengthen the parking/guarantor classifier prompt: determine the answer to the immediately preceding binary question from the affirmative/negative clause even if later text contains a separate question; return `accept` for `ок. а сколько денег дадите`. Apply the classifier decision before final response composition. Amend `unresolvedBinaryDecisionReply` so it repeats a binary prompt only if no new question exists in the current message; a direct or approved model answer to that question must be preserved.

- [ ] **Step 4: Run the named mixed-consent tests and confirm they pass**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='mixed parking consent'`

Expected: PASS.

### Task 3: Verify the complete behaviour

**Files:**
- Verify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Verify: `apps/api/src/dialogue/agent-turn.service.ts`

- [ ] **Step 1: Run both focused regression groups**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='residence-limit notice|mixed parking consent'`

Expected: PASS.

- [ ] **Step 2: Type-check the workspace**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Check the diff**

Run: `git diff --check && git diff -- apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: no whitespace errors and only server response composition plus binary-decision changes.
