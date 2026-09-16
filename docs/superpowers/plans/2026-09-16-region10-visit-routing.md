# Region-10 Visit Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent repeated server-owned visit questions and ensure a completed visit is confirmed only by the server-generated text with date, address, maps, and preliminary-confirmation wording.

**Architecture:** Keep the workflow model as an interpreter, but give server-owned visit responses precedence over the knowledge branch. When a visit slot is complete, suppress KB replacement and return the deterministic confirmation already produced by `AgentTurnService`.

**Tech Stack:** TypeScript, NestJS services, Vitest.

---

### Task 1: Reproduce the two routing regressions

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Inspect: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Inspect: `apps/api/src/dialogue/agent-turn.service.ts`

- [ ] Add a regression case where the current workflow answer already contains the canonical visit question and the following short client message must not receive that question twice.
- [ ] Add a regression case where the client supplies a complete visit slot while KB returns an unrelated answer; assert the final reply contains the server confirmation, address, map links, and preliminary-confirmation wording, and excludes the KB reply.
- [ ] Run the focused tests and confirm the new cases fail before the routing fix.

### Task 2: Give complete server-owned visit confirmation precedence

**Files:**
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] Detect from the post-workflow turn result when `visitDate` and `visitTime` are both present and the reply is a server-generated visit confirmation.
- [ ] Skip KB replacement for that turn, preserving the deterministic reply returned by `AgentTurnService`.
- [ ] Ensure the next workflow question is not appended after a complete visit confirmation.
- [ ] Run the focused orchestrator tests and the full `response-plan.service.spec.ts` suite.

### Task 3: Verify the final behavior

**Files:**
- Inspect: `apps/api/src/dialogue/response-validator.service.ts`

- [ ] Run the focused region-10/visit tests and the complete dialogue test file.
- [ ] Confirm the final diff contains only the routing fix and regression coverage.

