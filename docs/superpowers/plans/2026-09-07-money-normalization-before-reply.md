# Money normalization before dialogue reply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve a client’s monetary values and FX conversion before the dialogue model builds its reply, and never silently continue an obsolete aborted turn with missing money facts.

**Architecture:** The orchestrator will use the deterministic mention detector only as a trigger, call the semantic money normalizer first, supplement a partial response with the existing narrow parser, and resolve any FX conversion. The resulting facts and conversion metadata are supplied to the main dialogue model, then reused unchanged for persistence. Caller-triggered cancellation remains a cancellation; a normalizer timeout or invalid response is recorded and falls back only to deterministic, explicit monetary evidence.

**Tech Stack:** NestJS, TypeScript, Vitest, RouterAI client, NBKR conversion integration.

---

### Task 1: Specify ordering and cancellation with regression tests

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:61-121`

- [x] **Step 1: Write an ordering test that holds the normalizer until it has resolved**

```ts
const calls: string[] = [];
const agent = {
  normalizeMoney: vi.fn(async () => {
    calls.push("normalize:start");
    await normalizerGate;
    calls.push("normalize:done");
    return [{ field: "requestedAmount", amount: 600_000, currency: "KGS", confidence: 0.99 }];
  }),
  run: vi.fn(async (input) => {
    calls.push("run");
    expect(input.facts.requestedAmount).toBe(600_000);
    return validTurn;
  })
};

expect(calls).toEqual(["normalize:start"]);
releaseNormalizer();
await result;
expect(calls).toEqual(["normalize:start", "normalize:done", "run"]);
```

- [x] **Step 2: Write an abort test that proves no reply or lead-card writes occur**

```ts
const controller = new AbortController();
const agent = {
  normalizeMoney: vi.fn(async () => {
    controller.abort();
    throw new DOMException("aborted", "AbortError");
  }),
  run: vi.fn()
};

await expect(orchestrator.receiveBatch([message], { signal: controller.signal }))
  .rejects.toMatchObject({ name: "AbortError" });
expect(agent.run).not.toHaveBeenCalled();
expect(store.addMessage).not.toHaveBeenCalled();
```

- [x] **Step 3: Run the focused tests and confirm they fail against the old sequence**

Run: `pnpm --filter @ailyn/api test -- dialogue-orchestrator.service.spec.ts`

Expected: the ordering test fails because `run` precedes `normalizeMoney`; the cancellation test may currently pass only incidentally and must be reviewed for the intended guarantee.

### Task 2: Resolve money and FX before calling the dialogue agent

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:25-150`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Derive a narrow normalizer trigger before the main model**

```ts
const moneyMentioned = detectMoneyMentions(text).length > 0;
const modelNormalizedMoney = moneyMentioned && this.agent.normalizeMoney
  ? await this.agent.normalizeMoney({ text, facts: initialApplication.facts, messages: turnMessages, conversationId: conversation.id, signal: options.signal })
  : [];
throwIfAborted(options.signal);
```

`detectMoneyMentions` only decides whether a money value may be present; it does not decide the role when the model normalizer can do so.

- [x] **Step 2: Supplement and resolve values before the dialogue-model request**

```ts
const normalizedMoney = supplementNormalizedMoney(modelNormalizedMoney, text, initialApplication.facts, turnMessages);
const currency = await resolveNormalizedMoneyFacts(normalizedMoney, this.integrations, initialApplication.facts);
throwIfAborted(options.signal);
const normalizedFacts = effectiveFactsForTurn({
  previous: initialApplication.facts,
  modelPatch: {},
  explicitFacts: {},
  currencyFacts: currency.facts,
  attachmentFacts: {}
});
```

- [x] **Step 3: Build the dialogue request from normalized facts and current pricing**

```ts
let turn = await this.agent.run({
  conversationId: conversation.id,
  messages: turnMessages,
  facts: normalizedFacts,
  settings,
  text,
  currentTurnMessages,
  pricing: calculateLoanPricing(normalizedFacts, settings),
  currencyConversions: currency.conversions,
  attachments,
  signal: options.signal
});
```

- [x] **Step 4: Persist the same resolved facts after the dialogue result**

Use `currency.facts` already calculated above in `effectiveFactsForTurn`; remove the old post-reply normalizer invocation and the stale-workflow-replacement branch that only existed because money completed after response generation.

- [x] **Step 5: Update existing FX tests to assert the normalizer is called before `run` and the model receives converted facts**

```ts
expect(agent.normalizeMoney).toHaveBeenCalledBefore(agent.run as any);
expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
  facts: expect.objectContaining({ requestedAmount: 520_000 }),
  currencyConversions: [expect.objectContaining({ currency: "USD", somValue: 520_000 })]
}));
```

- [x] **Step 6: Run the focused orchestrator suite**

Run: `pnpm --filter @ailyn/api test -- dialogue-orchestrator.service.spec.ts`

Expected: PASS.

### Task 3: Preserve meaningful cancellation and diagnostic fallback

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:61-121`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Re-throw caller cancellation from `normalizeMoney`**

```ts
} catch (error) {
  if (input.signal?.aborted) throw error;
  // RouterAI timeout/invalid service response is not a caller cancellation.
  // Log it and let the deterministic supplemental parser handle only explicit evidence.
  ...
}
```

- [x] **Step 2: Keep timeout behavior non-destructive**

For a non-caller `AbortError` caused by the RouterAI timeout, log the failure and return `[]`; the orchestrator has already waited for that failure and proceeds only with explicit deterministic mentions. Do not persist model-inferred values that were never normalized.

- [x] **Step 3: Test a semantic-normalizer timeout with explicit money evidence**

```ts
agent.normalizeMoney.mockResolvedValue([]);
await orchestrator.receive(messageWith("нужно 600к"));
expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
  facts: expect.objectContaining({ requestedAmount: 600_000 })
}));
```

- [x] **Step 4: Run the API typecheck and full dialogue suite**

Run: `pnpm --filter @ailyn/api typecheck && pnpm --filter @ailyn/api test -- dialogue-orchestrator.service.spec.ts agent-turn-reconciliation.spec.ts money-normalization.spec.ts`

Expected: typecheck exits 0 and all selected tests pass.

- [x] **Step 5: Do not commit the shared dirty worktree**

The user selected inline execution and did not request a commit. Report the modified files and test evidence instead.

## Self-review

- Spec coverage: Task 2 ensures normalization and FX complete before the main reply; Task 3 ensures a superseded request cannot yield a partial reply while a service timeout remains diagnosable with narrow parser fallback; Task 1 protects ordering and cancellation.
- Placeholder scan: no TBD/TODO or generic testing steps remain.
- Type consistency: `NormalizedMoneyValue`, `ApplicationFacts`, `currency.facts`, and `currency.conversions` use the current orchestrator and AgentTurn input contracts.
