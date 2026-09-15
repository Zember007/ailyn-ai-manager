# Full Knowledge Corpus and Existing Loans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the knowledge model every approved source chunk while reliably redirecting questions about an already issued, past, or previous loan to the existing-contract support path.

**Architecture:** Retain the current relevant chunks at the front of the prompt, then append the complete approved FAQ and document corpus without the eight-chunk cap. Extend the server-owned existing-contract classifier with explicit references to a previous/past loan and requests for information about the client’s own loan; the existing approved redirect remains the public answer.

**Tech Stack:** TypeScript, NestJS, Vitest.

---

### Task 1: Expand existing-loan detection

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts:isExistingContractServiceRequest`

- [x] **Step 1: Write failing retrieval tests**

Add `selectRelevantDocumentation` assertions for `«Подскажи что в моем прошлом займе по инфе»`, `«информация по моему предыдущему договору»`, and `«что с моим старым займом»`. Each must return the `existing_contract_redirect` approved answer as `mandatoryAnswer`.

- [x] **Step 2: Run the focused test to verify failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts -t "past loan"`

Expected: FAIL because the present classifier only recognises current/due/GPS service patterns.

- [x] **Step 3: Add bounded past-loan and own-loan patterns**

Extend the server classifier to recognise `прошлый`, `предыдущий`, and `старый` next to `займ`/`договор`, plus requests for information about `моём`/`своём` loan. Do not classify a generic new-loan question merely because it contains the word `займ`.

- [x] **Step 4: Run the focused test to verify success**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts -t "past loan"`

Expected: PASS.

### Task 2: Pass the complete knowledge corpus

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts:prioritizedKnowledgeForQuestion`
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [x] **Step 1: Write a corpus-completeness regression**

Assert that `prioritizedKnowledgeForQuestion` includes every `generatedDocumentationChunks` key and every approved FAQ key, while the direct match is still the first entry.

- [x] **Step 2: Run the focused test to verify failure**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts -t "complete knowledge corpus"`

Expected: FAIL because the current packet is capped at eight chunks.

- [x] **Step 3: Append the full corpus after the ranked prefix**

Remove the packet cap and append all FAQ and documentation chunks after the current high-priority items, deduplicating by chunk key.

- [x] **Step 4: Run the focused tests and type-check**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-retrieval.spec.ts -t "past loan|complete knowledge corpus" && pnpm --filter @ailyn/api typecheck && git diff --check`

Expected: all commands exit successfully.
