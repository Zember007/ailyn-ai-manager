# Server-Owned Response Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate fact interpretation from client-facing prose so a model cannot add unsupported information or workflow steps.

**Architecture:** The input model continues to return structured facts. Server code derives a closed response plan: approved factual answer, mandatory notices, and at most one next stage question. A dedicated output model may make that plan sound natural but returns only a JSON reply; a server fallback returns the plan verbatim when rendering fails or contains disallowed content.

**Tech Stack:** NestJS, TypeScript, Vitest, RouterAI.

---

### Task 1: Define and render a closed response plan

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] **Step 1: Build server-owned reply before rendering**

Keep the existing server calculation and workflow guard as the response plan. Do not expose the input model reply as an allowed source when there is no approved answer or next stage.

- [x] **Step 2: Call the output renderer**

Send the renderer only the client message, recognised facts, server plan, and approved KB answer. Require JSON `{ "reply": string }`; prohibit new figures, currencies, products, questions, and facts.

- [x] **Step 3: Add fail-closed fallback**

If the renderer is unavailable, malformed, or invents an extra question, return the server plan without generated prose.

### Task 2: Make interpretation JSON-only

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`

- [x] **Step 1: Mark input reply as non-authoritative**

In the input prompt, state that `reply` is an internal acknowledgement only. It must not introduce information or decide stages; the server and output renderer own client prose.

### Task 3: Verify unsafe examples

- [x] **Step 1: Add regressions**

Test that `неа` does not create an unasked “это займ” explanation, a vehicle price is not repeated, and a converted euro amount is not converted a second time in model prose.

- [x] **Step 2: Run verification**

Run focused Vitest cases, `pnpm typecheck`, and `git diff --check`.
