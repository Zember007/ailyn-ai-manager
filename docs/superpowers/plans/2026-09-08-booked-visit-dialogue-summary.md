# Booked Visit Dialogue Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and persist one concise AI summary of the complete dialogue once a visit is booked, without exposing that field to dialogue models.

**Architecture:** Store the summary and generation timestamp as fields on `Application`, not in `ApplicationFacts`; facts are serialised into every agent prompt. After the turn that first persists both visit date and time, the orchestrator loads all saved and pending messages, invokes a dedicated summary call once, and performs a conditional database update so retries and future client messages cannot generate a second summary.

**Tech Stack:** NestJS, Prisma/PostgreSQL, RouterAI chat completion, Vitest.

---

### Task 1: Persist a private application summary

**Files:**
- Modify: `apps/api/prisma/schema.prisma:86-107`
- Create: `apps/api/prisma/migrations/<timestamp>_add_dialogue_summary/migration.sql`
- Modify: `apps/api/src/dialogue/stage1-store.service.ts:27-39, mapApplication, persistence methods`
- Test: `apps/api/src/dialogue/stage1-store.service.spec.ts`

- [ ] **Step 1: Write failing storage tests**

```ts
expect(application.dialogueSummary).toBeUndefined();
await store.saveDialogueSummary(application.id, "Клиент оформляет займ …");
expect((await store.getApplication(application.id))?.dialogueSummary).toContain("Клиент");
```

- [ ] **Step 2: Add nullable private columns and a conditional save method**

```prisma
dialogueSummary            String?   @db.Text
dialogueSummaryGeneratedAt DateTime?
```

```ts
async saveDialogueSummaryOnce(applicationId: string, summary: string): Promise<boolean> {
  const updated = await this.prisma.application.updateMany({
    where: { id: applicationId, dialogueSummary: null },
    data: { dialogueSummary: summary, dialogueSummaryGeneratedAt: new Date() }
  });
  return updated.count === 1;
}
```

- [ ] **Step 3: Run storage tests**

Run: `pnpm vitest apps/api/src/dialogue/stage1-store.service.spec.ts --run`

Expected: PASS.

### Task 2: Generate one private summary after the first booked visit

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts:126-164`
- Modify: `apps/api/src/ai/prompts/dialogue-summary.system.md`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing orchestration tests**

```ts
expect(agent.summarizeBookedDialogue).toHaveBeenCalledWith(expect.objectContaining({
  messages: expect.arrayContaining([expect.objectContaining({ body: "Camry 2022" })])
}));
expect(store.saveDialogueSummaryOnce).toHaveBeenCalledTimes(1);
```

Add a second post-visit client message and assert the summary method and save call are not repeated.

- [ ] **Step 2: Add a constrained summary call**

```ts
async summarizeBookedDialogue(input: { messages: Stage1Message[]; facts: ApplicationFacts }): Promise<string | undefined> {
  // Pass only client/AI dialogue and safe final facts; no previous summary.
  // Return one concise Russian summary, with no greeting or client-facing prose.
}
```

The system prompt must require factual, compact coverage of vehicle, requested amount/program, residence, documents, family/guarantor constraints and scheduled visit only when those items occur in the dialogue or facts.

- [ ] **Step 3: Trigger only after persistence of a first complete visit**

```ts
if (deriveStageCompletion(application.facts).visit && !application.dialogueSummary) {
  const summary = await this.agent.summarizeBookedDialogue({ messages: [...turnMessages, ...inbounds], facts: application.facts });
  if (summary) await this.store.saveDialogueSummaryOnce(application.id, summary);
}
```

Run after `updateFacts`, so the complete scheduled time is authoritative; perform it before the AI reply is appended only if the response message is included explicitly in the summary input.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --run -t "summary|booked visit"`

Expected: PASS.

### Task 3: Verify privacy and build integrity

**Files:**
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Add a prompt-boundary test**

```ts
expect(agent.run).toHaveBeenCalledWith(expect.objectContaining({
  facts: expect.not.objectContaining({ dialogueSummary: expect.anything() })
}));
```

- [ ] **Step 2: Run verification**

Run: `pnpm lint && pnpm typecheck && pnpm vitest apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts --run && git diff --check`

Expected: all commands pass.
