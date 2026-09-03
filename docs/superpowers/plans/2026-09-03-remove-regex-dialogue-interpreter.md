# Remove Regex Dialogue Interpreter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the single conversational model, rather than Russian-language regular expressions, interpret every client answer while it receives and returns the complete lead card.

**Architecture:** `DialogueOrchestratorService` continues to supply the entire persisted `ApplicationFacts` object, all dialogue messages and attachments to one `AgentTurnService` request. The model returns a cumulative `leadCardPatch`; the server merges it with prior facts, derives attachment inventory, validates JSON and calculates only deterministic business outputs (stage prerequisites, loan limits and target events). Remove text-dependent local interpretation and any rule that overwrites an unambiguous model fact from a regex or locality lookup.

**Tech Stack:** NestJS, TypeScript, Zod, Prisma/PostgreSQL, Vitest, RouterAI JSON mode.

---

## File map

- `apps/api/src/dialogue/agent-turn.service.ts` — builds the model context, validates the response and currently contains the regex-based `interpretCurrentTurn()` path to remove from production flow.
- `apps/api/src/dialogue/dialogue-orchestrator.service.ts` — persists the final cumulative card; stop applying the removed local text parser a second time.
- `apps/api/src/dialogue/agent-turn-reconciliation.ts` — remains the non-linguistic boundary for accumulating attachment facts, mandatory-stage ordering, target events and approved financial calculations.
- `apps/api/src/ai/prompts/agent.system.md` — makes the model's ownership of language interpretation and full-card output unambiguous.
- `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts` — covers the real one-model-call pipeline and regressions for flexible replies.
- `packages/business-rules/src/locality-region.ts` — stays available for approved deterministic locality normalization only after the model has given a category; it must not decide whether a free-form answer is an answer to the current dialogue question.

### Task 1: Establish flexible-answer regressions

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a failing region-choice regression where the model interprets a natural answer.**

  Mock a valid model result with the cumulative patch below and give it the previous AI question about registration. The client answer must be a formulation that the old hard-coded resolver cannot classify, for example `я не из бишкека и не из чуя`.

  ```ts
  leadCardPatch: {
    requestedProgram: "without_storage",
    residenceText: "я не из бишкека и не из чуя",
    residenceRegion: "Другой регион Кыргызстана",
    residenceCategory: "OTHER_KG",
    residenceNeedsClarification: false
  }
  ```

  Assert `AgentTurnService.run()` returns `OTHER_KG`, does not make a retry call and does not repeat the registration question.

- [ ] **Step 2: Add two equivalent regressions for another stage.**

  Use a previous guarantor question and `поручителя смогу привести` with a model patch of `guarantorAvailable: true`; use a previous family-status question and `мы официально женаты` with a patch of `familyStatus: "married"`. Assert the proposed values persist even though they are not a member of a local yes/no regex list.

- [ ] **Step 3: Run the focused test before the change.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

  Expected: the new region case fails because `interpretCurrentTurn()` overwrites the model patch with `residenceNeedsClarification: true` when `resolveKyrgyzstanLocality()` returns `undefined`.

- [ ] **Step 4: Commit the regression tests.**

  ```bash
  git add apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
  git commit -m "test: cover flexible model-interpreted dialogue answers"
  ```

### Task 2: Remove language parsing from the production state boundary

**Files:**

- Modify: `apps/api/src/dialogue/agent-turn.service.ts:100-260, 430-710`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:20-45`

- [ ] **Step 1: Delete `interpretCurrentTurn()` from the runtime path and its regex-only helpers.**

  Remove calls that use `text` plus message history to produce `explicitFacts`, including:

  ```ts
  interpretCurrentTurn({ text: input.text, facts: input.facts, messages: input.messages })
  ```

  Delete `lastUnresolvedQuestion`, `isResidenceAnswer`, `extractAlternativeLimit`, `extractExplicitVehicleYear`, and the regex branches for programme, family, guarantor, document refusal, car-photo refusal, locality and visit recognition. Do not replace them with new phrase dictionaries or locale matching.

- [ ] **Step 2: Preserve only non-linguistic merges in `finalizeAgentPayload()`.**

  Build effective facts using the model's full patch and attachment classification only:

  ```ts
  const effectiveFacts = effectiveFactsForTurn({
    previous: input.facts,
    modelPatch: parsed.leadCardPatch,
    explicitFacts: {},
    currencyFacts: {},
    attachmentFacts: attachmentFactsFromResult(input.facts, parsed.attachments)
  });
  ```

  Keep `reconcileAgentTurn()` because it contains no NLP: it selects the earliest missing mandatory field, derives target events and calculates the approved preliminary limit. Remove semantic errors and reply rewrites whose premise is an inferred client meaning; retain structural checks such as unknown attachment IDs and requests for an already received document.

- [ ] **Step 3: Stop applying the deleted parser while persisting.**

  In `DialogueOrchestratorService.receive()`, use the complete model patch plus attachment and foreign-currency facts as the effective input. Do not call any function that reads `message.text` to override a model's `leadCardPatch`.

- [ ] **Step 4: Run the focused tests and verify the flexible answers pass.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

  Expected: PASS. The region, guarantor and family cases use the model's semantic interpretation without any server-side phrase matching.

- [ ] **Step 5: Commit the refactor.**

  ```bash
  git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
  git commit -m "refactor: delegate dialogue fact interpretation to agent"
  ```

### Task 3: Make the complete-card contract enforceable

**Files:**

- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: State the ownership boundary in the prompt.**

  Add these requirements under `КАРТОЧКА ЛИДА — ОБЯЗАТЕЛЬНОЕ ЗАПОЛНЕНИЕ`:

  ```md
  - Вы — единственный интерпретатор естественного языка клиента. Понимайте ответы по смыслу в любом регистре, формулировке и поддерживаемом языке, соотнося их с историей и текущим незавершённым вопросом.
  - Не ждите точного совпадения с вариантами вопроса. Например, смысловой ответ «я не из бишкека и не из чуя» на вопрос о прописке означает `residenceCategory="OTHER_KG"`.
  - После обработки текущего сообщения верните полный актуальный `leadCardPatch`: все известные прежние разрешённые поля плюс все новые и исправленные факты текущего хода. Последнее однозначное сообщение клиента имеет приоритет.
  ```

- [ ] **Step 2: Test that the model receives the whole card and history, not a stage-specific projection.**

  In the existing context test, provide facts from at least three unrelated stages (vehicle data, received document inventory and a visit preference). Parse the outbound JSON request and assert every supplied key is present in `leadCard`, while the full message history is present in `history`.

- [ ] **Step 3: Run the entire dialogue and business-rule test set.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts packages/business-rules/src/index.spec.ts`

  Expected: PASS. If `agent-turn-reconciliation.spec.ts` does not exist, omit only that path; do not suppress failures in the other two suites.

- [ ] **Step 4: Commit the contract and verification.**

  ```bash
  git add apps/api/src/ai/prompts/agent.system.md apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
  git commit -m "docs: define model-owned dialogue interpretation"
  ```

### Task 4: Verify the original live regression end to end

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add the exact reproduction as an integration-style unit test.**

  Use complete vehicle, value, amount and selected-program facts; the last AI message asks `Ваша прописка: Бишкек; Чуйская область; другой регион Кыргызстана.` The client message is exactly `другой регион Кыргызстана`. Mock a valid model response with `residenceCategory: "OTHER_KG"` and a next document request.

  Assert all of the following:

  ```ts
  expect(output.result?.leadCardPatch).toEqual(expect.objectContaining({
    residenceRegion: "Другой регион Кыргызстана",
    residenceCategory: "OTHER_KG",
    residenceNeedsClarification: false
  }));
  expect(output.reply).not.toContain("Ваша прописка");
  expect(client.createChatCompletion).toHaveBeenCalledTimes(1);
  ```

- [ ] **Step 2: Run the production-equivalent focused suite.**

  Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

  Expected: PASS with one model call and no repeated residence prompt.

- [ ] **Step 3: Commit the permanent regression guard.**

  ```bash
  git add apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
  git commit -m "test: prevent repeated residence question after explicit reply"
  ```

## Self-review

- The plan removes server-side natural-language interpretation across all conversation stages, not merely the three residence labels.
- It preserves the full lead-card input/output contract and attachment inventory.
- It deliberately retains deterministic financial calculations and structural state safety; those are business invariants, not text recognition.
- The exact production symptom has a permanent regression test.
