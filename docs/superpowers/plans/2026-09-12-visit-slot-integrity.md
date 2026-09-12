# Visit Slot Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Never invent a visit time and always acknowledge a client-corrected booked slot.

**Architecture:** The language model may interpret prose, but only the deterministic visit parser can write `visitDate` or `visitTime`. A date-only answer stores only the date; an explicit correction to an existing booking keeps its date, replaces the parsed time, and uses the canonical confirmation renderer.

**Tech Stack:** TypeScript, Vitest, NestJS.

---

### Task 1: Protect visit facts from model invention

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1238-1260`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] Add a regression where the model returns `visitTime: "15:00"` for «не знаю, может в понедельник смогу»; assert only the Monday date is stored and the reply asks for time.
- [x] Exclude `visitRequested`, `visitDate`, `visitTime`, and `visitConfirmationPending` from the model patch before server reconciliation.
- [x] Run the focused test and confirm it passes.

### Task 2: Apply and confirm a time correction after booking

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.service.ts:1736-1762`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] Add a regression for a complete existing slot and «в 3 неудобно, давайте в 6»; assert the date is retained, `visitTime` becomes `18:00`, and the reply confirms 18:00.
- [x] Permit deterministic parsing of an explicit time correction after a completed booking, even if the last message is the final-questions prompt.
- [x] Run focused visit tests, then `pnpm typecheck`.

### Task 3: Preserve the other half of an explicitly changed slot

**Files:**
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [x] Explain that an already booked visit may be changed through a new date or time; the model must not invent or overwrite the other half of the slot.
- [x] For an explicit visit change after booking, retain the saved date when only time is supplied, and retain the saved time when only date is supplied.
- [x] Add regressions for «приеду всё-таки в 6» and «Изменились планы, приеду во вторник» and run focused tests plus typecheck.
