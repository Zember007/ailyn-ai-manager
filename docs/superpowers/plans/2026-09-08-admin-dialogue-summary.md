# Admin Dialogue Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the private post-booking dialogue summary in the lead card of the admin conversation page.

**Architecture:** The API already maps `Application.dialogueSummary` into the conversation payload. Extend the admin-side `Stage1Application` contract to retain that field, then render it using the shared `Field` component in `LeadCard`. The summary remains outside `facts`, so it never becomes agent input.

**Tech Stack:** Next.js, React, TypeScript, Prisma-backed API.

---

### Task 1: Expose the summary in the admin lead card

**Files:**
- Modify: `apps/admin/app/lib/api.ts:48-64`
- Modify: `apps/admin/app/components.tsx:48-71`
- Test: `pnpm --filter @ailyn/admin typecheck`

- [ ] **Step 1: Extend the client application contract**

Add the optional API field next to `agentState`:

```ts
  dialogueSummary?: string;
```

- [ ] **Step 2: Render the saved summary in the lead card**

Add a standard card field after the visit and before next action:

```tsx
      <Field label="Краткая сводка" value={application?.dialogueSummary} />
```

- [ ] **Step 3: Verify the admin package**

Run: `pnpm --filter @ailyn/admin typecheck`

Expected: exits with code 0.

- [ ] **Step 4: Verify the repository checks**

Run: `pnpm lint && pnpm typecheck && git diff --check`

Expected: all commands exit with code 0.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/app/lib/api.ts apps/admin/app/components.tsx docs/superpowers/plans/2026-09-08-admin-dialogue-summary.md
git commit -m "feat(admin): show dialogue summary in lead card"
```
