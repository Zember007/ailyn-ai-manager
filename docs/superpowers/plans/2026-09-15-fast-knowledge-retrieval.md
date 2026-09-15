# Fast Knowledge Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce knowledge-answer latency by configuring a dedicated fast model and sending it only a compact, relevant evidence packet.

**Architecture:** `ROUTERAI_KNOWLEDGE_MODEL` selects the KB model independently from the primary dialogue model. Retrieval retains exact FAQ matches, targeted document passages, and compact core rules, but removes the full approved-FAQ dump and irrelevant existing-contract rules from ordinary questions.

**Tech Stack:** TypeScript, Vitest, RouterAI Chat Completions configuration.

---

### Task 1: Configure a dedicated KB model

**Files:**
- Modify: `.env:14`
- Modify: `.env.example:14-17`

- [ ] **Step 1: Add the failing configuration expectation**

```ts
expect(process.env.ROUTERAI_KNOWLEDGE_MODEL).toBe("openai/gpt-4o-mini");
```

- [ ] **Step 2: Add the configuration**

```dotenv
ROUTERAI_KNOWLEDGE_MODEL=openai/gpt-4o-mini
```

- [ ] **Step 3: Verify the effective environment line is present**

Run: `rg -n '^ROUTERAI_KNOWLEDGE_MODEL=' .env .env.example`

Expected: both files set `openai/gpt-4o-mini`.

### Task 2: Restrict the knowledge packet to relevant evidence

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts:105-124, 282-286`
- Test: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] **Step 1: Write a failing retrieval test**

```ts
const packet = prioritizedKnowledgeForQuestion({ facts: {}, currentMessage: "Можно деньги на карту?", messages: [] });
expect(packet.some((chunk) => chunk.key === "faq_card_disbursement")).toBe(true);
expect(packet.some((chunk) => chunk.key === "faq_gps_requirement")).toBe(false);
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm vitest run apps/api/src/dialogue/documentation-retrieval.spec.ts`

Expected: FAIL because the current packet includes every approved FAQ, including the GPS FAQ.

- [ ] **Step 3: Keep only exact/strong FAQ matches and targeted passages**

```ts
const selected = selectRelevantDocumentation({ ...input, includeCrossStageMatches: true, maxChunks: 4 });
const matchedFaq = availableFaq.filter((chunk) => hasExactApprovedFaqAlias(chunk, current) || matchesApprovedQuestion(chunk, tokens));
return uniqueKnowledge([
  ...exactMatchedFaq,
  ...matchedFaq,
  ...selected.knowledge,
  ...selected.commonKnowledge
]);
```

Use a two-token minimum in `matchesApprovedQuestion` so a shared generic word cannot include an unrelated FAQ.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm vitest run apps/api/src/dialogue/documentation-retrieval.spec.ts && pnpm --filter @ailyn/api typecheck`

Expected: PASS.

### Task 3: Verify the change

**Files:**
- Verify only: `.env`, `.env.example`, `apps/api/src/dialogue/documentation-retrieval.ts`

- [ ] **Step 1: Run lint and inspect whitespace errors**

Run: `pnpm eslint apps/api/src/dialogue/documentation-retrieval.ts apps/api/src/dialogue/documentation-retrieval.spec.ts --max-warnings=0 && git diff --check`

Expected: PASS.
