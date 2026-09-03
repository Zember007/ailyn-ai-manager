# Remove Deterministic Dialogue Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the organizing model the sole owner of dialogue-stage decisions and client replies.

**Architecture:** Keep TypeScript responsible only for transport, schema validation, attachment inventory, currency conversion, and persistence. Remove post-model stage reconciliation, requirement-based reply replacement, and deterministic financial rewrites; pass the full lead card and knowledge to the model and persist its validated output.

**Tech Stack:** NestJS, TypeScript, Zod, Vitest.

---

### Task 1: Remove post-model dialogue decisions

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] Remove `reconcileAgentTurn`, `missingRequirementReply`, `reconcileFinancialReply`, and related deterministic semantic-stage correction from the runtime path.
- [ ] Persist the model's validated `dialogueState`, `targetEvent`, `preliminaryLimit`, and reply without replacing them with templates.
- [ ] Retain only merging of prior facts, model facts, currency facts, and attachment inventory.
- [ ] Add regression coverage proving a model reply containing guarantor requirements is returned unchanged and a model patch `{ guarantorAvailable: true }` is persisted.

### Task 2: Strengthen organizer-model contract

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] State that the model must bind short confirmations such as “да” to the last unanswered question and emit the corresponding fact in `leadCardPatch`.
- [ ] State that the model must determine family status and guarantor order from the full card/history and include guarantor requirements when required by knowledge.
- [ ] State that no server-side template will repair a missing fact or reply.

### Task 3: Verify

**Files:**
- No new files.

- [ ] Run focused dialogue tests.
- [ ] Run API typecheck and full test suite.
- [ ] Run `git diff --check`.
