# Single-Agent Fact Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current single RouterAI turn persist every unambiguous current-turn client fact and attachment result without allowing stale lead-card values or structurally valid model JSON to silently lose them.

**Architecture:** Keep `MessagesController -> DialogueOrchestratorService -> AgentTurnService` and the single multimodal RouterAI call. The model proposes client-facing prose, stage, program interpretation and a preliminary amount from its supplied knowledge chunks; deterministic code interprets narrow unambiguous inputs, calculates the final preliminary amount, merges an effective state, and validates/reconciles the proposed state, target event and manager update. Do not call legacy `evaluateApplication()` as the dialogue engine or add a second model path.

**Tech Stack:** NestJS, TypeScript, Zod, Prisma/PostgreSQL, Vitest, RouterAI JSON mode.

## Implementation update (2026-09-03)

- The final `preliminaryLimit` remains the deterministic TypeScript business decision; a model value is only validated as a proposal and is never persisted as authoritative.
- `targetEvent` is reconciled from effective/persisted readiness. A model value of `documents` while the agent is merely requesting missing documents is cleared, not treated as an invalid semantic event.
- After the three main-agent attempts are exhausted, the pipeline invokes `ROUTERAI_NORMALIZER_MODEL` (default `openai/gpt-4o-mini`) with the raw response, validation error and safe context. This model repairs JSON shape/types only; the repaired result goes through the same Zod, fact, stage, limit and event reconciliation boundary. If repair is unsafe, the existing logged fallback remains.
- Prompt loading checks source and compiled API paths, preventing `Prompt file not found: agent.system.md` during local `apps/api dev` startup.
- Explicit vehicle years are reconciled from the current client message when a vehicle cue or a year suffix makes the meaning unambiguous. This current-turn value overrides a conflicting model patch and older lead-card value.
- The agent receives every generated documentation chunk on every turn. Relevance scoring, stage filtering and top-N truncation are removed from `AgentTurnService`.

---

## Audit findings

1. `DialogueOrchestratorService.receive()` persists the inbound message and calls the single `AgentTurnService`, but then saves `turn.result.dialogueState` directly. There is no explicit `before facts + current turn patch = effective facts` boundary.
2. `normalizeAgentPayload()` carries prior facts and applies the model patch, but `explicitLeadFacts()` currently only covers family status, document refusal and simple visit values. A current amount, program selection or guarantor answer can therefore depend entirely on the model reproducing it.
3. The money parser can identify two labelled values, but the conversion path does not safely carry a nearby explicit currency to a shortened second amount such as `стоит 20 тыс долларов, надо 10`. The second amount is not a standalone money mention today.
4. Attachment classification is persisted as `Attachment` rows after the model call, but successful `turn.result.attachments` are not deterministically merged into `ApplicationFacts.documents`. A following turn can therefore see neither ID side in `leadCard` even though the attachment row exists.
5. JSON/Zod retry exists, but a structurally valid result that drops an explicit fact or asks for an attachment already classified in the same turn is accepted.
6. `selectedProgramLimit()` deterministically calculates the amount stored in `agentState`, but the current pipeline neither verifies a model-proposed `preliminaryLimit` against it nor checks the reply/state for a conflict.
7. `packages/business-rules` contains historical broad flow helpers. The implementation must not add `evaluateApplication()` to the orchestrator; instead it needs a small current-pipeline validator whose only job is to prevent transitions over missing mandatory data.

### Task 1: Add failing current-turn reconciliation tests

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.spec.ts` if it exists; otherwise keep the AgentTurn unit cases in `dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing tests for explicit fact precedence**

Add a mocked agent result whose `leadCardPatch` preserves an old requested amount, then send a current message containing an unambiguous correction. Assert that `store.updateFacts()` receives the new amount, not the old patch value.

```ts
it("uses an explicit current amount over a stale model patch", async () => {
  const agent = { run: vi.fn().mockResolvedValue({
    result: { ...validResult, leadCardPatch: { requestedAmount: 200_000 } },
    reply: validResult.reply, model: "one", promptVersion: "v1"
  }) } as any;
  // initial application facts contain 200_000; current message is a correction
  await service.receive({ ...message, text: "нет, надо 450 тысяч" });
  expect(store.updateFacts).toHaveBeenCalledWith(application, expect.objectContaining({ requestedAmount: 450_000 }));
});
```

- [ ] **Step 2: Write failing tests for program and guarantor short answers**

Use a history ending with the AI question about a guarantor and send `да`; expect `guarantorAvailable: true`. Send `тогда давайте на стоянку`; expect `requestedProgram: "parking"`. Add a control case `а если на стоянку сколько дадите` and assert it does not replace `requestedProgram`.

- [ ] **Step 3: Write failing tests for document state and same-turn reply**

Mock `attachments` with received `id_front` and `id_back`; assert the persisted facts contain both document statuses. Add a model reply that asks for either received side and assert it causes the model retry rather than persistence.

- [ ] **Step 4: Run the focused tests and verify they fail**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because current code does not reconcile explicit program/guarantor/document facts and has no semantic retry.

### Task 2: Make deterministic interpretation a narrow, reusable current-turn input

**Files:**

- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Replace `explicitLeadFacts(text, currentPatch)` with a context-aware interpreter**

Export a small `interpretCurrentTurn()` function which receives `{ text, facts, messages }` and returns only high-confidence facts. It must retain the existing family-status, document-decline and date/time parsing, then add:

```ts
type CurrentTurnInterpretation = {
  facts: Partial<ApplicationFacts>;
  money: ReturnType<typeof resolveMoneyFacts>;
};

export function interpretCurrentTurn(input: {
  text?: string;
  facts: ApplicationFacts;
  messages: Stage1Message[];
}): CurrentTurnInterpretation;
```

Detect an explicit program only for affirmative selections (`"давайте на стоянку"`, `"буду со стоянкой"`, `"без изъятия"`); do not infer a change from a hypothetical question. Resolve `да`/`нет` as `guarantorAvailable` only when the latest AI message is specifically asking whether a guarantor exists. Use `resolveMoneyFacts` for money facts only when a role is explicit or unambiguously pending.

- [ ] **Step 2: Put this exact interpretation in the model context**

In `buildMessage()`, replace the present `explicitLeadFacts(input.text, {})` with `interpretCurrentTurn({ text: input.text, facts: input.facts, messages: input.messages })`. Serialize its `facts` and money hints as `interpretedCurrentMessage`.

- [ ] **Step 3: Apply interpreter facts after model aliases/normalization**

In `normalizeAgentPayload()`, use the interpretation as the last assignment for explicit fields:

```ts
const interpreted = interpretCurrentTurn({ text: inputText, facts: currentFacts, messages });
Object.assign(patch, interpreted.facts);
```

Pass `messages` into the normalizer from `run()`. This order establishes `current explicit user value > model patch > previous facts` while preserving existing facts that were not changed this turn.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS for amount correction, explicit program switch, hypothetical program question and guarantor context.

### Task 3: Repair bounded two-role money interpretation and currency inheritance

**Files:**

- Modify: `apps/api/src/dialogue/money-normalization.ts`
- Test: `apps/api/src/dialogue/money-normalization.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add failing money regressions**

```ts
it("assigns a nearby shared USD currency to a shortened requested amount", () => {
  const result = resolveMoneyFacts({
    text: "Камри 2022 стоит 20 тыс долларов, надо 10",
    currentFacts: {}
  });
  expect(result.vehicleValue).toBe(20_000);
  expect(result.vehicleValueCurrency).toBe("USD");
  expect(result.requestedAmount).toBe(10_000);
  expect(result.requestedAmountCurrency).toBe("USD");
});
```

Add a counterexample (`"надо 10"` with no nearby amount/currency) asserting that no amount is manufactured.

- [ ] **Step 2: Implement clause-bounded inheritance**

After normal mention extraction, consider an otherwise unambiguous bare numeric amount only when all conditions hold: it follows a money mention with explicit currency in the same comma/semicolon/sentence clause, it has a requested/vehicle cue, and no competing currency appears. Create a new mention with the inherited currency and the role implied by its cue. Do not infer currency across messages or when the bare value could be a year/time/phone number.

- [ ] **Step 3: Feed reconciled foreign-money facts into the current turn**

Keep `resolveForeignCurrencyFacts()` as a conversion adapter, but call the same `resolveMoneyFacts()` result used by the interpreter so both money roles are considered. The converted KGS values must override the model patch only for explicit, successfully converted values in this message.

- [ ] **Step 4: Run money and orchestrator tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; both USD roles persist, while isolated ambiguous `10` remains unresolved.

### Task 4: Build one effective-state, document-inventory and stage-reconciliation boundary

**Files:**

- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Create: `apps/api/src/dialogue/agent-turn-reconciliation.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a pure current-pipeline reconciler, not a new orchestration layer**

Create `agent-turn-reconciliation.ts` as a pure helper imported by the existing agent/orchestrator. It must export an effective-state merge and a reconciliation function:

```ts
export function effectiveFactsForTurn(input: {
  previous: ApplicationFacts;
  modelPatch: Partial<ApplicationFacts>;
  explicitFacts: Partial<ApplicationFacts>;
  currencyFacts: Partial<ApplicationFacts>;
  attachmentFacts: Partial<ApplicationFacts>;
}): ApplicationFacts {
  return { ...input.previous, ...input.modelPatch, ...input.currencyFacts, ...input.attachmentFacts, ...input.explicitFacts };
}

export function reconcileAgentTurn(input: {
  effectiveFacts: ApplicationFacts;
  proposedState: AgentTurnResult["dialogueState"];
  proposedTargetEvent: AgentTurnResult["targetEvent"];
  proposedPreliminaryLimit: number | null | undefined;
  deterministicPreliminaryLimit: number | null;
}): {
  state: AgentTurnResult["dialogueState"];
  targetEvent: "documents" | "visit" | null;
  semanticErrors: string[];
};
```

The reconciler may use a small, explicit prerequisite map matching the active `agent.system.md` flow. It must return the earliest missing stage when the proposal skips mandatory data: vehicle identity/year, vehicle value, requested amount, selected program, residence, required document sides, then required visit date/time. It must not infer a broad business decision or call `evaluateApplication()`.

- [ ] **Step 2: Derive a document facts patch from successful current attachments**

Map received `id_front`, `id_back`, `vehicle_registration_front`, `vehicle_registration_back` and `car` classification to `facts.documents`. Merge with the previous document object so a later car photo never removes ID sides. Ignore `unknown`, `poor_quality` and `blocked` as received documents.

- [ ] **Step 3: Persist effective facts before state and notification decisions**

Replace the direct `leadCardPatch` write with the effective facts delta. Reload the application after `updateFacts()` and use that reloaded state for subsequent persistence. Save only the reconciled state. Derive `targetEvent` from persisted/effective readiness: `documents` requires all four required sides received; `visit` additionally requires a valid date and time. Derive initial/delta manager status from the verified target event and actual changed fields, not `managerUpdate.kind` from the model.

- [ ] **Step 4: Keep `selectedProgramLimit()` as the final deterministic amount**

Keep `selectedProgramLimit()` and save its value in `agentState.preliminaryLimit`. Pass the model proposal to the reconciler; when both values are present and unequal, emit `preliminary_limit_conflict` and retry the current single AgentTurn. Never save the model-proposed number as authoritative state.

- [ ] **Step 5: Run persistence-focused tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/stage1-store.service.spec.ts`

Expected: PASS; documents remain in `ApplicationFacts`, an explicit program/amount supersedes old values, the reconciled stage cannot pass missing required facts, and the stored preliminary amount is deterministic.

### Task 5: Add semantic consistency retry without introducing a second model call path

**Files:**

- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a failing semantic-retry test**

Mock the first `createChatCompletion()` response as schema-valid but with a reply asking for an ID side represented as `received` in current facts or current result attachments. Mock a corrected second response. Assert two model calls and only the corrected reply reaches the orchestrator.

- [ ] **Step 2: Add a narrow semantic validator**

Add a private validation function adjacent to `normalizeAgentPayload()` that accepts the normalized result, the effective/current facts, current attachment classifications and the reconciler output. It returns stable error codes for:

```ts
"explicit_fact_lost:<field>"
"reply_reasks_received_document:<documentCode>"
"invalid_stage_transition:<stage>:missing:<field>"
"program_conflict"
"preliminary_limit_conflict"
"invalid_target_event:<event>"
"attachment_state_conflict:<attachmentId>"
```

For document detection use a small fixed map of document codes to the prompt’s canonical Russian request fragments. Derive short `да`/`нет` from the last logically unresolved question supplied by the reconciler/context, not merely the last AI message. Do not attempt generic NLP validation of all reply prose or use legacy rules as a dialogue engine.

- [ ] **Step 3: Reuse the existing three attempts**

After Zod succeeds, calculate effective facts and run semantic validation. If the reconciler can safely correct only the proposed stage to the earliest missing stage, use the corrected stage and record the correction. For a conflict that can make reply/state false (`explicit_fact_lost`, repeated document, program, preliminary amount, target event or attachment conflict), throw an error containing the codes so the existing retry loop sends the same original context with an added instruction such as:

```text
СЕМАНТИЧЕСКАЯ ОШИБКА: reply_reasks_received_document:id_front.
Соберите заново полный AgentTurnResult. Не теряйте явные факты текущего сообщения и не запрашивайте уже полученные документы.
```

Keep the three-attempt limit and existing fallback log; add semantic error codes to its attempt metadata.

- [ ] **Step 4: Run semantic retry tests**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS; semantically contradictory JSON retries once and no user sees the contradiction.

### Task 6: Tighten prompt invariants and validate the test-chat behavior

**Files:**

- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Inspect: `apps/admin/app/conversations/[id]/conversation-composer.tsx`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add only the missing atomic-turn prompt instructions**

Insert a compact block before the JSON contract:

```text
ТЕКУЩИЙ ХОД АТОМАРЕН: сначала обработайте все факты текста и все attachments этого сообщения, затем соберите полный leadCardPatch и мысленно примените его к leadCard. Только по этому обновлённому состоянию выбирайте reply, stage и nextAction.
Последнее однозначное значение клиента заменяет старое. Не теряйте независимые факты одного сообщения. Не помещайте computed fields, включая preliminaryLimit, внутрь leadCardPatch.
Не спрашивайте документ/сторону, уже отмеченную received в leadCard или успешно распознанную среди attachments текущего хода.
Вопрос о другой программе не меняет requestedProgram; явный выбор меняет его. Короткое «да»/«нет» сначала соотносите с последним логически незавершённым вопросом, а не с произвольной старой репликой.
```

- [ ] **Step 2: Inspect, then minimally test the test-chat composer**

Confirm whether `isSubmitting` disables the submit control while the current request is pending. If it does, document that this is a test-UI serialization issue, not a dialogue-state issue. Do not add a queue unless a reproducible test shows that the UI drops or reorders messages.

- [ ] **Step 3: Run the complete relevant verification suite**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/stage1-store.service.spec.ts
pnpm --filter @ailyn/api typecheck
pnpm lint
git diff --check
```

Expected: all focused tests and typecheck pass; lint either passes or reports pre-existing failures separately.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/money-normalization.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/ai/prompts/agent.system.md docs/superpowers/plans/2026-09-03-single-agent-fact-consistency.md
git commit -m "fix: reconcile single-agent turn facts"
```

Do not include pre-existing deletions of `AI_PIPELINE.md` or `AILYN_AI_PIPELINE_CODEX_PROMPT.md` unless their owner explicitly requests their deletion.

## Plan self-review

- Coverage: explicit facts, last value wins, two money roles with clause-bounded currency inheritance, program selection vs hypothetical questions, guarantor context, document persistence/same-turn awareness, semantic retry, deterministic preliminary-limit authority, deterministic stage/target/manager reconciliation, prompt invariants and test UI inspection are covered.
- Deliberate exclusions: no new orchestration layer, no multi-call extraction pipeline, no `RouterAiProvider` migration, no new database schema, no `evaluateApplication()` stage gating, and no generic Russian NLP engine.
- Product decision applied: legacy `evaluateApplication()` is not used as the dialogue engine. The model uses approved chunks for dialogue; code preserves facts and deterministically validates prerequisites, final preliminary limit, event readiness and manager updates.
