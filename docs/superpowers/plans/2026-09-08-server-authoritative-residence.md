# Server-Authoritative Residence Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Categorize residence only from the TypeScript locality catalogue and request a Chuy confirmation when code cannot resolve a locality.

**Architecture:** The existing SOATE-derived locality catalogue remains the only authority for city and village classification. The turn processor replaces an unverified model category with the raw locality plus a clarification state; it resolves the clarification reply deterministically.

**Tech Stack:** TypeScript, Vitest, official SOATE locality catalogue.

---

### Task 1: Make locality classification server-authoritative

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/agent-turn-reconciliation.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write regression tests for Bosteri and an unrecognized locality.**
- [ ] **Step 2: Persist only code-resolved categories; retain unknown locality text with `residenceNeedsClarification=true`.**
- [ ] **Step 3: Ask `Подскажите, пожалуйста, это в Чуйской области?` for the clarification state.**
- [ ] **Step 4: Map yes/no to Chuy/other-Kyrgyzstan only when replying to that exact question.**

### Task 2: Repair and verify the catalogue boundary

**Files:**
- Modify: `packages/business-rules/src/locality-region.ts`
- Test: `packages/business-rules/src/index.spec.ts`

- [ ] **Step 1: Add the audited Bosteri alias as `OTHER_KG`.**
- [ ] **Step 2: Run focused residence tests, lint, and typecheck.**
