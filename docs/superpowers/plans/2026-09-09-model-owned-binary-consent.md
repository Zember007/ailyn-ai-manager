# Model-Owned Binary Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the semantic model always resolves an active guarantor-to-parking consent step, including abbreviated follow-up questions, while deterministic code remains an outage fallback only.

**Architecture:** `AgentTurnService` will determine that the guarantor-to-parking decision is active from persisted application facts and the last assistant question, rather than requiring the rewritten message to retain the word «поручитель». It will invoke the semantic classifier for that active state on every customer response. A narrowly scoped regex fallback will remain only after the model path is unavailable or undecided.

**Tech Stack:** NestJS, TypeScript, Vitest.

---

### Task 1: Lock the rewritten parking-question regression in a unit test

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:1273-1324`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a test whose last AI message is `Уточните, пожалуйста: Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?`, whose facts require a guarantor and record `guarantorAvailable: false`, and whose customer text is `да`. Return the normal agent payload first and `{"decision":"accept"}` from the second, classifier request. Assert `requestedProgram: "parking"`, `guarantorAlternativeDeclined: false`, and two model calls.

- [ ] **Step 2: Run test to verify it fails**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='rewritten parking question'`.

Expected: FAIL because the old detector rejects a parking-only wording, so the classifier call is never made and `requestedProgram` stays `without_storage`.

- [ ] **Step 3: Implement active decision detection**

In `apps/api/src/dialogue/agent-turn.service.ts`, add `isActiveGuarantorParkingAlternative(lastAssistant, facts)`. It must require `requestedProgram === "without_storage"`, `guarantorAvailable === false`, no recorded alternative refusal, and an explicit offer to consider or switch to the guarded parking programme. The wording detector must match `Можем рассмотреть программу с постановкой автомобиля на охраняемую стоянку?`, but must exclude general pricing and parking-location questions. Use this helper in `resolveGuarantorDecision`, `guarantorPatchFromClearReply`, and `unresolvedBinaryDecisionReply`.

- [ ] **Step 4: Run test to verify it passes**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='rewritten parking question'`.

Expected: PASS; the second model call is the classifier and its accepted decision switches the programme to `parking`.

- [ ] **Step 5: Commit**

Run `git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && git commit -m "fix: classify abbreviated parking consent"`.

### Task 2: Verify model priority over fallback

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:1273-1324`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a model-priority assertion**

In the regression test, assert that `client.createChatCompletion.mock.calls[1][0].messages[0].content` contains `согласен ли он перейти на программу со стоянкой вместо поручителя`. This proves the semantic classifier, not regex parsing, owns the state transition.

- [ ] **Step 2: Run focused verification**

Run `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --testNamePattern='rewritten parking question'`.

Expected: PASS.

- [ ] **Step 3: Run static verification**

Run `pnpm typecheck` and `git diff --check`.

Expected: both commands exit with code 0.

- [ ] **Step 4: Commit**

Run `git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && git commit -m "test: protect model-owned parking consent"`.

## Self-review

- Spec coverage: Task 1 removes the message-wording gate that caused bare `да` to be ignored; Task 2 proves model-first classification.
- Placeholder scan: no TBD/TODO or unspecified behavior remains.
- Type consistency: `ApplicationFacts`, `requestedProgram`, `guarantorAvailable`, and `guarantorAlternativeDeclined` are existing service fields.
