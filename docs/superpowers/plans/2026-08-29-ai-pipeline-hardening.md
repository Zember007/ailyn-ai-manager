# AI Pipeline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Stage 1 AI pipeline regressions around price capture, attachment scanning, and end-to-end local verification.

**Architecture:** Keep business decisions deterministic in `packages/business-rules` and harden only the AI boundary and attachment contracts. Extend extraction to use conversation context, pass real attachment content into the pipeline, and analyze text/files/images conservatively without inventing business facts.

**Tech Stack:** NestJS, TypeScript, Prisma, Vitest, RouterAI provider abstraction

---

### Task 1: Diagnose and cover the price-capture regression

**Files:**
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add failing tests for short numeric replies in context**
- [ ] **Step 2: Add a regression test for the repeated vehicle-price question flow**
- [ ] **Step 3: Run targeted tests and confirm the current implementation fails**

### Task 2: Harden extraction and attachment contracts

**Files:**
- Modify: `apps/api/src/ai/ai-provider.interface.ts`
- Modify: `apps/api/src/channels/channel.interface.ts`
- Modify: `apps/api/src/messages/messages.controller.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.ts`

- [ ] **Step 1: Extend attachment payloads so uploaded content can reach the analyzer**
- [ ] **Step 2: Teach local extraction to infer price vs requested amount from current missing facts and message phrasing**
- [ ] **Step 3: Add conservative text/file/image scanning helpers for Stage 1 fallback analysis**
- [ ] **Step 4: Merge extracted attachment facts into the stored application facts**

### Task 3: Verify attachment handling and Stage 1 contracts

**Files:**
- Modify: `apps/api/src/messages/messages.controller.spec.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Modify: `apps/api/src/scenarios/scenarios.service.ts`

- [ ] **Step 1: Add tests proving uploaded file content is forwarded**
- [ ] **Step 2: Add tests for ID/registration/car-photo classification from content and filenames**
- [ ] **Step 3: Update scenario contracts only if needed to reflect the strengthened attachment pipeline**

### Task 4: Run local end-to-end verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-29-ai-pipeline-hardening.md`

- [ ] **Step 1: Start local dependencies and apply Prisma migrations**
- [ ] **Step 2: Run targeted dialogue requests for the reported price bug**
- [ ] **Step 3: Run attachment requests with text files and photos through the local API**
- [ ] **Step 4: Run `pnpm typecheck`, `pnpm test`, `pnpm test:scenarios`, and `pnpm build`**
- [ ] **Step 5: Mark any unresolved production-safe gaps explicitly instead of guessing**
