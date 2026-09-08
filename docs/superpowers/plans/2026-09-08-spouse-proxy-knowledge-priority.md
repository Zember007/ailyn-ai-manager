# Spouse Proxy Knowledge Priority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the generic «займ по доверенности нельзя» FAQ from overriding the approved rule for a vehicle owned by a spouse.

**Architecture:** Treat a message that combines a power of attorney with a spouse reference as a separate ownership clarification context. Exclude the generic proxy-loan FAQ from mandatory-answer selection in that context, preserve the approved document chunk 4.27 for the knowledge model, and replace the prompt’s long special-case priority paragraph with a short evidence-selection rule.

**Tech Stack:** TypeScript, Vitest, RouterAI knowledge prompt.

---

### Task 1: Prefer the spouse ownership rule over the generic proxy FAQ

**Files:**
- Modify: `apps/api/src/dialogue/documentation-retrieval.ts`
- Modify: `apps/api/src/ai/prompts/knowledge-agent.system.md`
- Modify: `apps/api/src/dialogue/documentation-retrieval.spec.ts`

- [ ] **Step 1: Write a failing retrieval test**

Add a test for «А доверенность на жену?» which asserts that no mandatory proxy-loan refusal is selected and that section `4.27` is included in the knowledge packet.

- [ ] **Step 2: Exclude the generic proxy FAQ in spouse context**

Detect a message containing both a power-of-attorney word stem and a spouse reference. When true, omit FAQ key `faq_power_of_attorney` from mandatory-answer and prioritized FAQ matching; retain DOCX chunk 4.27.

- [ ] **Step 3: Simplify the knowledge-model instruction**

Replace the long trust/exception paragraph with the rule to use one most-specific approved passage, not combine unrelated passages, and ask the approved clarification when the passage requires unknown ownership details.

- [ ] **Step 4: Run focused verification**

Run: `pnpm vitest apps/api/src/dialogue/documentation-retrieval.spec.ts --run`

Expected: exits with code 0.

- [ ] **Step 5: Run static verification**

Run: `pnpm lint && pnpm typecheck && git diff --check`

Expected: all commands exit with code 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/dialogue/documentation-retrieval.ts apps/api/src/ai/prompts/knowledge-agent.system.md apps/api/src/dialogue/documentation-retrieval.spec.ts docs/superpowers/plans/2026-09-08-spouse-proxy-knowledge-priority.md
git commit -m "fix(knowledge): prioritize spouse ownership over proxy FAQ"
```
