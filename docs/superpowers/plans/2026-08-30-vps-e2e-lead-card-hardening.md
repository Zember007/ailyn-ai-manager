# VPS E2E Lead Card Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make live VPS end-to-end dialogues finish cleanly, hard-stop region-10 refusals, preserve explicit residence clarification, and populate the lead card from a completed dialogue with uploaded images.

**Architecture:** Strengthen deterministic extraction and validation around critical turns instead of trusting RouterAI phrasing. Keep business decisions in `packages/business-rules`, use validator-backed response repair for terminal refusals, and cover the full lead-card completion path with scenario tests.

**Tech Stack:** NestJS, Prisma, Vitest, TypeScript, RouterAI provider abstraction

---

### Task 1: Lock the desired behavior in regression tests

**Files:**
- Modify: `apps/api/src/dialogue/response-validator.service.spec.ts`
- Modify: `apps/api/src/dialogue/fact-normalizer.spec.ts`
- Modify: `apps/api/src/ai/router-ai/router-ai.provider.spec.ts`
- Modify: `tests/scenarios/dialogue-e2e.scenario.spec.ts`

- [ ] Add tests for terminal refusal repair, deterministic full-name/phone extraction, and a completed dialogue that leaves the lead card populated.

### Task 2: Harden deterministic extraction and refusal handling

**Files:**
- Modify: `apps/api/src/dialogue/fact-normalizer.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Modify: `apps/api/src/dialogue/response-validator.service.ts`
- Modify: `packages/business-rules/src/index.ts`

- [ ] Extract borrower full name and phone from explicit user text, inherit phone from a phone-like web-test contact id when missing, and make region-10 refusal final and client-safe.

### Task 3: Verify the whole completed-card path

**Files:**
- Modify: `tests/scenarios/dialogue-e2e.scenario.spec.ts`

- [ ] Cover a full completed dialogue with uploaded image attachments, family status, and visit scheduling so the stored application facts match the lead-card fields.

### Task 4: Run full verification and deploy

**Files:**
- No code changes expected

- [ ] Run targeted tests, then `pnpm typecheck`, `pnpm test`, `pnpm test:scenarios`, and `pnpm build`.
- [ ] Commit, push to `main`, wait for VPS deployment, and rerun 5 full live scenarios to completion with image uploads and lead-card verification.
