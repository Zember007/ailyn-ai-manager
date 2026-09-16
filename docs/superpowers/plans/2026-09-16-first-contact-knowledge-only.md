# First-contact knowledge-only replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer a first-message KB question without starting the new-loan workflow, while preserving the approved redirect for existing-loan servicing.

**Architecture:** The KB model classifies a standalone first-message FAQ as `requestScope: "not_new_loan"` and returns its grounded answer. The orchestrator treats such a response as knowledge-only: it does not append a workflow stage and it bypasses the new-loan greeting. Existing-contract requests still use their approved p.3.18 redirect as the KB answer.

**Tech Stack:** NestJS 11, TypeScript, Vitest, Zod structured KB response.

---

### Task 1: Define first-contact KB scope in the prompt

**Files:**
- Modify: `apps/api/src/ai/prompts/knowledge-agent.system.md:36-37`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write the failing prompt contract test**

```ts
expect(request.messages[0].content).toContain("самостоятельный вопрос по knowledge");
expect(request.messages[0].content).toContain('requestScope="not_new_loan"');
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'marks a standalone first-message KB question as outside the new-loan workflow'`

Expected: FAIL because the prompt requires all non-new-loan first messages to return only the redirect.

- [ ] **Step 3: Replace the first-message prompt rule**

```md
- Если `isFirstClientMessage=true`, сначала определите цель обращения. Если клиент явно просит новый займ, передаёт данные для заявки или спрашивает условия именно нового займа, используйте `requestScope="new_loan"`. Если это самостоятельный вопрос, на который есть ответ в `knowledge`, но клиент не говорит о получении нового займа и не передаёт данные анкеты, ответьте только на этот вопрос, поставьте `requestScope="not_new_loan"` и не добавляйте приветствие, документы, условия нового займа или этап анкеты. Для обслуживания старого/текущего займа используйте только редирект п. 3.18. Если это не новый займ и точного ответа в `knowledge` нет, верните утверждённый редирект: «Я Айлин — виртуальный помощник по вопросам оформления новых займов. Если Ваш вопрос не связан с получением нового займа, позвоните по телефону +996 502 108 108 или напишите в WhatsApp +996 776 108 108. Наши специалисты проверят информацию по Вашему договору и помогут решить Ваш вопрос.»
```

- [ ] **Step 4: Run the focused prompt contract test and verify it passes**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'marks a standalone first-message KB question as outside the new-loan workflow'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ai/prompts/knowledge-agent.system.md apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "feat: classify standalone first-contact KB questions"
```

### Task 2: Suppress the greeting and workflow only for first-contact KB replies

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:220-320,465-480`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing orchestration tests**

```ts
expect(output.reply).toBe("Да, для наших клиентов есть чай и кофе.");
expect(output.reply).not.toMatch(/Здравствуйте|ориентировочную стоимость|документ/iu);

expect(existingContractOutput.reply).toBe(existingContractRedirect);
expect(existingContractOutput.reply).not.toMatch(/Здравствуйте|ориентировочную стоимость/iu);
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'does not start a new-loan workflow for a standalone first-message KB question|does not add the new-loan greeting to a first-message existing-contract redirect'`

Expected: FAIL because `enforceFirstContactGreeting()` currently runs for every first visible reply.

- [ ] **Step 3: Track and apply the knowledge-only first-contact decision**

```ts
let firstMessageIsKnowledgeOnly = false;

// Immediately after answerWithKnowledge()
firstMessageIsKnowledgeOnly = conversation.messages.length === 0
  && (knowledge?.answerFound || knowledge?.shouldUseReply === true)
  && knowledge.requestScope !== "new_loan";

const reply = vehicleValueBelowMinimum
  ? VEHICLE_VALUE_BELOW_MINIMUM_REPLY
  : serverOwnsReply || firstMessageIsKnowledgeOnly
    ? plannedReply
    : enforceFirstContactGreeting(plannedReply, { messages: conversation.messages, text, currentTurnMessages, hadPriorAssistantMessage: false });
```

Keep the existing `continuesNewLoanWorkflow` condition: on an empty conversation, `requestScope="not_new_loan"` already prevents `workflowFollowUpAfterKnowledge()` from adding a stage question.

- [ ] **Step 4: Run the focused tests and verify they pass**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'does not start a new-loan workflow for a standalone first-message KB question|does not add the new-loan greeting to a first-message existing-contract redirect'`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "fix: keep first-contact KB questions outside loan workflow"
```

### Task 3: Verify the complete first-contact boundary

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Run all related regression tests**

Run: `pnpm vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'first-message|first contact|existing-contract|knowledge'`

Expected: PASS, including the existing tests for active new-loan workflow continuation.

- [ ] **Step 2: Run static checks**

Run: `pnpm exec tsc -p apps/api/tsconfig.json --noEmit && pnpm exec eslint apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && git diff --check`

Expected: all commands exit with code 0.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "test: cover first-contact knowledge-only replies"
```
