# Knowledge-First Question Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every inbound turn through the knowledge agent and ensure explicit questions about an existing loan or a manager callback override the application workflow with an approved answer.

**Architecture:** Keep workflow extraction and fact persistence unchanged, but invoke the KB after every successful workflow turn. The KB result replaces the workflow response only when it confirms that it answered a question; otherwise the ordinary next-stage workflow remains intact. Broaden current-loan semantic recognition in both retrieval and workflow guards, and explicitly instruct the KB to resolve natural paraphrases from approved evidence rather than requiring an alias match.

**Tech Stack:** NestJS, TypeScript, Vitest, generated documentation chunks.

---

### Task 1: Cover natural existing-loan and callback questions

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write retrieval tests for balance/payment wording and manager callback wording**

```ts
it.each([
  "а сколько я на сегодня должен вам",
  "хочу заехать оплатить, сколько на сегодня мне надо привезти"
])("routes natural existing-loan wording to the approved redirect: %s", (currentMessage) => {
  expect(selectRelevantDocumentation({ facts: {}, currentMessage, messages: [] }).mandatoryAnswer)
    .toContain("Если у Вас уже оформлен займ");
});
```

- [ ] **Step 2: Write an orchestrator test proving KB runs for an explicit question even when workflow did not request it**

```ts
expect(agent.answerWithKnowledge).toHaveBeenCalledWith(expect.objectContaining({
  text: "а когда позвонит менеджер"
}));
expect(output.reply).toBe("Обычно менеджер связывается с клиентами в течение часа.");
```

- [ ] **Step 3: Run the focused tests and confirm they fail before implementation**

Run: `pnpm vitest run apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'natural existing-loan|KB runs'`

Expected: FAIL because the natural payment forms are not classified and the KB call remains conditional.

### Task 2: Make approved knowledge evaluation unconditional and safe

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:160-230`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:187-330`

- [ ] **Step 1: Invoke `answerWithKnowledge` for every non-refused turn with a workflow result**

```ts
if (!vehicleValueBelowMinimum && turn.result) {
  const knowledge = await this.agent.answerWithKnowledge(/* current turn, reconciled facts, workflow follow-up */);
  if (knowledge?.answerFound) {
    turn = { ...turn, reply: knowledge.reply, model: knowledge.model };
  }
}
```

- [ ] **Step 2: Preserve the workflow reply when KB returns `answerFound: false`**

```ts
if (!knowledge?.answerFound) {
  // Keep the already validated workflow reply and its next stage.
}
```

- [ ] **Step 3: Run the focused tests and confirm they pass**

Run: `pnpm vitest run apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'natural existing-loan|KB runs'`

Expected: PASS.

### Task 3: Recognize semantic variants and make the prompt answer-first

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/ai/prompts/knowledge-agent.system.md`

- [ ] **Step 1: Expand existing-loan recognition for direct balance and payment-intent forms**

```ts
/(?:сколько|какуюs+сумму).{0,45}(?:должp{L}*|привезp{L}*|оплатp{L}*|погасp{L}*)|(?:заехp{L}*|приехp{L}*).{0,45}оплатp{L}*/iu
```

Use the same semantics in retrieval and the workflow guard so a redirect cannot be removed after it is selected.

- [ ] **Step 2: Strengthen the KB prompt’s question contract**

```md
Every client turn is sent to you. Do not require a literal alias match: recognize natural paraphrases and inflections from the meaning of approved material. For every explicit question, `answerFound=true` is mandatory when its answer follows from `knowledge` or `leadCard`; never replace it with a workflow question or a generic closing.
```

- [ ] **Step 3: Run formatting/type and targeted test verification**

Run: `pnpm --filter @ailyn/api typecheck && pnpm eslint apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/documentation-retrieval.ts --max-warnings=0 && pnpm vitest run apps/api/src/dialogue/documentation-retrieval.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t 'existing-loan|KB runs|manager'`

Expected: all selected checks pass.
