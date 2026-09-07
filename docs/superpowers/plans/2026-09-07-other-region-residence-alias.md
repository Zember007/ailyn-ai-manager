# Other Region Residence Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize `other_region` from the model into a complete OTHER_KG residence so the residence stage cannot reopen.

**Architecture:** The JSON boundary in `agent-turn.service.ts` canonicalizes model-friendly residence aliases and derives the missing residence category from a canonical region. The existing stage-completion controller then advances using the complete card rather than asking for residence again.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Regression test

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Add a turn where the model writes `residenceRegion: "other_region"` without `residenceCategory`**

```ts
expect(output.result?.leadCardPatch).toMatchObject({
  residenceRegion: "Другой регион Кыргызстана",
  residenceCategory: "OTHER_KG",
  residenceNeedsClarification: false
});
expect(output.reply).not.toContain("Вашу прописку");
```

- [x] **Step 2: Run the focused dialogue test and confirm it fails before implementation**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the result lacks `residenceCategory` and repeats the residence question.

### Task 2: Canonicalize aliases

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1170-1220`

- [x] **Step 1: Add `OTHER_REGION` to `residenceRegionAliases`**

```ts
OTHER_REGION: "Другой регион Кыргызстана"
```

- [x] **Step 2: Backfill `residenceCategory` after canonicalizing `residenceRegion`**

```ts
if (patch.residenceCategory === undefined && patch.residenceRegion === "Другой регион Кыргызстана") {
  patch.residenceCategory = "OTHER_KG";
  patch.residenceNeedsClarification = false;
}
```

- [x] **Step 3: Re-run the focused dialogue test and confirm it passes**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: the card contains `OTHER_KG`; the reply advances to the amount-limit or guarantor branch, not residence.

### Task 3: Verify

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Run the dialogue regression suite**

Run: `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/agent-turn-reconciliation.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts apps/api/src/dialogue/money-normalization.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts packages/business-rules/src/index.spec.ts`

- [x] **Step 2: Run type checking and whitespace validation**

Run: `pnpm --filter @ailyn/api typecheck && git diff --check`
