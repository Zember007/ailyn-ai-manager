# Structured Documentation Chunks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `АЙЛИН 6.2` chunks at numbered-point and question-answer boundaries, with bounded contextual overlap that never mixes approved answers.

**Architecture:** Replace the generic paragraph buffer with a parser that starts a parent group at every numbered heading. Ordinary long groups split at sentence boundaries and carry two prior sentences (maximum 320 characters); §§20.3–20.4 split into isolated question-answer records with no overlap and a verbatim policy.

**Tech Stack:** Node.js ESM, `unzip` OOXML extraction, TypeScript, Vitest.

---

### Task 1: Specify the generated metadata

**Files:**

- Modify: `apps/api/src/dialogue/documentation-chunks.generated.spec.ts`
- Test: `apps/api/src/dialogue/documentation-chunks.generated.spec.ts`

- [ ] Write failing assertions that generated chunks contain `sourceSection`, that normal continuations have an `overlapFromPrevious` of at most 320 characters, and that `responsePolicy: "verbatim"` chunks have no overlap.
- [ ] Run `pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-chunks.generated.spec.ts`; expect failure because these fields do not yet exist.
- [ ] Commit with `git add apps/api/src/dialogue/documentation-chunks.generated.spec.ts && git commit -m "test: specify structured documentation chunks"`.

### Task 2: Replace the generic buffer splitter

**Files:**

- Modify: `scripts/generate-documentation-chunks.mjs`
- Modify: `apps/api/src/dialogue/documentation-chunks.generated.ts` (generated)
- Test: `apps/api/src/dialogue/documentation-chunks.generated.spec.ts`

- [ ] Implement `splitDocumentIntoGroups(paragraphs)`: each part matching `^(?:\d+\.\d+(?:\.\d+)?)\b` closes the previous group and starts `{ sourceSection: heading, paragraphs: [part] }`; otherwise append the part to the current group.
- [ ] Implement `splitWithOverlap(text, maximumLength = 1200)`: split with `text.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)`, and when adding a sentence would exceed the limit, begin the next chunk with `tailSentences(current, 2, 320)` and expose that tail as `overlapFromPrevious`.
- [ ] Emit `sourceSection`, `chunkIndex`, and optional `overlapFromPrevious` for each normal generated record.
- [ ] Regenerate and run `node scripts/generate-documentation-chunks.mjs && pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-chunks.generated.spec.ts`; expect pass.
- [ ] Commit with `git add scripts/generate-documentation-chunks.mjs apps/api/src/dialogue/documentation-chunks.generated.ts apps/api/src/dialogue/documentation-chunks.generated.spec.ts && git commit -m "feat: preserve section context in documentation chunks"`.

### Task 3: Isolate sections 20.3 and 20.4 as exact question-answer chunks

**Files:**

- Modify: `scripts/generate-documentation-chunks.mjs`
- Modify: `apps/api/src/dialogue/documentation-chunks.generated.ts` (generated)
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] Implement `splitApprovedQuestionAnswers(text)` only for sections `20.3` and `20.4`, using `text.matchAll(/([^?]{3,}\?)\s*([^?]+?)(?=\s+[^?]{3,}\?|$)/gu)` to produce one `{ approvedQuestion, approvedAnswer, text }` record per pair.
- [ ] For each such record emit `responsePolicy: "verbatim"`, `approvedQuestion`, `approvedAnswer`, and never emit `overlapFromPrevious`.
- [ ] Preserve owner-approved overrides: card answer `К сожалению только наличными`; GPS answer `Это зависит от суммы займа и состояния автомобиля. Точно ответить сможем после осмотра автомобиля.`
- [ ] Add a retrieval test asserting the selected pair for `Можно деньги на карту?` has `approvedAnswer: "К сожалению только наличными"`.
- [ ] Regenerate and run `node scripts/generate-documentation-chunks.mjs && pnpm exec vitest run --config vitest.config.ts apps/api/src/dialogue/documentation-chunks.generated.spec.ts apps/api/src/dialogue/documentation-retrieval.spec.ts`; expect pass.
- [ ] Commit with `git add scripts/generate-documentation-chunks.mjs apps/api/src/dialogue/documentation-chunks.generated.ts apps/api/src/dialogue/documentation-retrieval.spec.ts && git commit -m "feat: isolate approved documentation answers"`.

### Task 4: Rank exact pairs above surrounding context

**Files:**

- Modify: `apps/api/src/dialogue/documentation-retrieval.ts`
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] Add an `approvedQuestionScore`: for a `responsePolicy === "verbatim"` chunk, tokenize `approvedQuestion`, multiply its overlap with client tokens by 30, and include it in the ranking score.
- [ ] Test that `Можно деньги на карту?` ranks the matching approved pair before any neighbouring FAQ context.
- [ ] Run `pnpm test && pnpm typecheck && pnpm lint && git diff --check`; expect all tests pass, no TypeScript errors, no ESLint warnings, and no whitespace errors.
- [ ] Commit with `git add apps/api/src/dialogue/documentation-retrieval.ts apps/api/src/dialogue/documentation-retrieval.spec.ts && git commit -m "feat: rank approved documentation answers precisely"`.

## Self-review

- Tasks 1–2 cover point boundaries and normal overlap.
- Task 3 prohibits overlap between approved question-answer pairs.
- Task 4 prevents a neighbouring answer from outranking the exact match.
- The change stays inside document generation and retrieval; it does not rewrite the dialogue-agent architecture.
