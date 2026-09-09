# Server-Owned Vehicle Age Notice and No-Echo Responses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the approved older-than-15-years notice exactly once through server code and prevent the dialogue model from restating facts the client just provided.

**Architecture:** Keep vehicle age as an application fact derived from the extracted year, but make the client-facing notice exclusively server-owned in `AgentTurnService`. Remove all prompt-level age-policy instructions so the model cannot independently generate or duplicate this message. Tighten the agent prompt's response contract to prohibit summarizing, quoting, formatting, or repeating already known client facts unless a clarification explicitly needs them.

**Tech Stack:** TypeScript, NestJS, Vitest, workspace business rules.

---

### Task 1: Make the age notice server-owned and testable

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:888-892,1676-1681`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:2170-2221`

- [ ] **Step 1: Write failing regression tests**

Add tests for a 2010 car that assert the exact approved notice is prepended once when the model omits it, remains absent for a 2011 car in 2026, and is not repeated when an earlier AI message already contains it.

```ts
expect(output.reply).toContain(OLDER_VEHICLE_PROGRAM_NOTICE);
expect(output.reply.match(/автомобили старше 15 лет/giu)).toHaveLength(1);
```

- [ ] **Step 2: Run the focused test file to verify the new tests fail**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because the notice is currently duplicated by the region-10 continuation path and relies directly on `new Date()` rather than the shared server calculation.

- [ ] **Step 3: Centralize the server calculation and message**

Export one approved-notice constant and one helper that receives `facts`, server settings, and previous AI messages. Use it in both ordinary response finalization and the region-10 batch continuation; delete the second hand-written age-message variant. The helper returns the exact notice only when `currentYear - vehicleYear > 15` and no prior AI message already contains the approved notice.

```ts
export const OLDER_VEHICLE_PROGRAM_NOTICE =
  "По общему правилу мы принимаем в залог автомобили старше 15 лет только на стоянку, но если вы планируете получить займ без изъятия, то мы готовы рассмотреть вашу заявку индивидуально.";
```

- [ ] **Step 4: Run the focused test file to verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/dialogue/agent-turn.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "fix: make older vehicle notice server-owned"
```

### Task 2: Remove age-policy prose from model prompts and prohibit client-fact echoing

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md:102-104,202-203`
- Modify: `apps/api/src/dialogue/agent-stage-instructions.ts:3`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts:2170-2221`

- [ ] **Step 1: Write failing assertions for prompt boundaries**

Add a regression test that reads the prompts used by the dialogue agent and asserts that they contain no `старше 15` / `15 лет` policy text. Assert the prompt explicitly prohibits quoting, listing, summarizing, bolding, or reformatting client facts.

```ts
expect(agentPrompt).not.toMatch(/старше 15|15 лет/iu);
expect(agentPrompt).toContain("Никогда не цитируйте, не перечисляйте");
```

- [ ] **Step 2: Run the focused test file to verify the prompt assertion fails**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: FAIL because the current prompts still contain the age rule and lack the explicit no-echo wording.

- [ ] **Step 3: Update only the model instructions**

Remove every older-than-15-years instruction and response template from `agent.system.md` and `agent-stage-instructions.ts`. Replace the existing weak no-restatement line in `agent.system.md` with an explicit rule: never quote, list, summarize, bold, or reformat model/year/value/loan amount/program/residence supplied by the client in the current or previous turn; store the fact in `leadCardPatch`, then provide only an approved answer, a necessary correction, or the next question. Add a narrowly scoped server cleanup that removes an echoed vehicle-summary sentence when all its facts were supplied in the current client turn, preserving a genuine clarification or server-owned notice.
Remove every older-than-15-years instruction and response template from `agent.system.md` and `agent-stage-instructions.ts`. Replace the existing weak no-restatement line in `agent.system.md` with an explicit rule: never quote, list, summarize, bold, or reformat model/year/value/loan amount/program/residence supplied by the client in the current or previous turn; store the fact in `leadCardPatch`, then provide only an approved answer, a necessary correction, or the next question. Do not add server-side prose filtering for this issue: the model prompt is the intended boundary.

- [ ] **Step 4: Run the focused test file to verify it passes**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/ai/prompts/agent.system.md apps/api/src/dialogue/agent-stage-instructions.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts
git commit -m "fix: prevent dialogue from echoing client facts"
```

### Task 3: Verify the complete change

**Files:**
- Verify: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`
- Verify: `packages/business-rules/src/index.spec.ts`

- [ ] **Step 1: Scan the model prompts**

Run: `rg -n -i 'старше 15|15 лет' apps/api/src/ai/prompts apps/api/src/dialogue/agent-stage-instructions.ts`

Expected: no matches.

- [ ] **Step 2: Run dialogue and business-rule tests**

Run: `pnpm vitest run --config vitest.config.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts packages/business-rules/src/index.spec.ts`

Expected: PASS.

- [ ] **Step 3: Run type checking**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Commit verification-only changes if required**

```bash
git status --short
```

Expected: no uncommitted changes from the implementation.
