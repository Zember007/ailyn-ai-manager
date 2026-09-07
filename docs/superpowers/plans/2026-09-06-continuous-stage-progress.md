# Continuous Stage Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Have Ailyn answer each client question, save all new data, and then advance the incomplete loan application by exactly one stage question in the same reply.

**Architecture:** Establish one global response order: update the effective lead card, answer the client, then ask the earliest missing prerequisite for a visit. The application-stage prompt mirrors this priority; completed, explicitly refused, and existing-contract conversations remain terminal exceptions.

**Tech Stack:** Markdown system prompts, TypeScript template strings, Vitest.

---

### Task 1: Make continuous progression a global invariant

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md:1.0-1.1, 5, 8`

- [ ] **Step 1: Replace no-follow-up exceptions**

Change rules that stop after standalone FAQ, identity, fallback, or verbatim knowledge responses. After the answer, require exactly one question for the earliest incomplete application field.

- [ ] **Step 2: Protect terminal cases**

Keep no-follow-up behavior only for an explicit end to the application, an existing-contract redirect without new-loan intent, or a completed visit/application.

### Task 2: Reinforce response order in active stage instructions

**Files:**
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts:application`

- [ ] **Step 1: Require the next field question**

State the sequence: save facts, answer questions, then ask exactly one earliest missing prerequisite for the visit; an FAQ never ends an active application turn.

### Task 3: Verify prompt compilation and focused dialogue tests

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Run type checking**

Run: `pnpm --filter @ailyn/api typecheck`

Expected: exits with code 0.

- [ ] **Step 2: Check prompt whitespace**

Run: `git diff --check`

Expected: exits with code 0.
