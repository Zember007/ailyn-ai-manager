# Agent-Led Understanding Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Stage 1 dialogue understanding from brittle local phrase parsing to RouterAI-led structured extraction.

**Architecture:** RouterAI is the primary interpreter for client text, documents, context, intents, questions, missing information, and attachment classification. TypeScript validates the structured contract, persists state, handles explicit phone fallback from channel metadata, converts foreign currencies only through the deferred FX boundary, and evaluates deterministic loan/business rules.

**Tech Stack:** NestJS, TypeScript, RouterAI chat completions, Vitest, Zod.

---

### Task 1: Operational Contract

**Files:**
- Modify: `AGENTS.md`

- [x] **Step 1: Update the RouterAI boundary**

Add explicit instructions that RouterAI should receive enough runtime context to understand natural client messages and attachments, while deterministic code remains responsible for numeric loan calculations and business decisions.

- [x] **Step 2: Forbid brittle parser expansion**

Document that local keyword dictionaries, spelling variants, and regular-expression phrase maps are allowed only for emergency fallback, schema validation, or deterministic numeric post-processing of already extracted values.

### Task 2: Primary Extraction Flow

**Files:**
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/ai/prompts/extraction.system.md`

- [x] **Step 1: Remove local extraction fast path**

Configured RouterAI must be called before local extraction. Keep `localExtract` only for unconfigured local development and RouterAI error fallback.

- [x] **Step 2: Strengthen the extraction prompt**

Tell RouterAI to infer flexible natural phrasing, typos, transliteration, short contextual replies, document text, and missing facts in structured JSON without producing client-facing text.

### Task 3: Orchestrator Fact Merge

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`

- [x] **Step 1: Remove contextual parser overlay**

Stop calling `normalizeTurnFacts` after RouterAI extraction. The orchestrator should merge extraction facts, foreign-currency conversions, and attachment facts only.

- [x] **Step 2: Remove hard-coded owner/plate text checks**

Require `ownerChanged` and `plateChanged` to arrive from RouterAI extraction.

### Task 4: Attachment Understanding

**Files:**
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`
- Modify: `apps/api/src/ai/prompts/vision.system.md`

- [x] **Step 1: Call RouterAI for attachment analysis**

When RouterAI is configured, send attachment metadata and available text/OCR/base64 presence to the vision model with a strict JSON response contract.

- [x] **Step 2: Keep local attachment inference as fallback**

Use existing local classification only when RouterAI is not configured or returns invalid output.

### Task 5: Verification

**Files:**
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Update provider tests**

Add assertions that configured RouterAI is called for extraction and vision even when local fallback would have understood the message.

- [x] **Step 2: Update orchestrator tests**

Assert fact updates are driven by extracted facts and attachment facts, not by the removed contextual parser overlay.

- [x] **Step 3: Run targeted and broad checks**

Run `pnpm test -- --run apps/api/src/ai/router-ai/router-ai.provider.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`, then `pnpm typecheck`.
