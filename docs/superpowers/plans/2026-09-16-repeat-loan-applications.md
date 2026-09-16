# Repeat Loan Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a separate application for a verified closed loan when the same client asks for a new loan, retaining only durable client data and requiring current collateral evidence.

**Architecture:** Add a server-owned `CLOSED` application lifecycle state and a contact-level profile persisted in `Contact.metadata`. The dialogue orchestrator will detect repeat-loan wording only after loading a closed application for the same contact, atomically create a new application with persistent facts, and process the current message against that new application. Vehicle, amount, programme, visit, and vehicle-registration documents remain solely on the old application and are deliberately excluded from the new one.

**Tech Stack:** TypeScript, NestJS 11, Prisma/PostgreSQL, Vitest, Zod.

---

## File structure

| File | Responsibility |
| --- | --- |
| `apps/api/prisma/schema.prisma` | Add the durable closed-loan lifecycle value. |
| `apps/api/prisma/migrations/<timestamp>_add_closed_application_state/migration.sql` | Apply the PostgreSQL enum migration. |
| `packages/business-rules/src/index.ts` | Represent the repeat-loan collection stage and force vehicle-first collection without treating saved ID as saved STS. |
| `apps/api/src/dialogue/repeat-loan.ts` | Pure detection, persistent-fact selection, and collateral-fact exclusion. |
| `apps/api/src/dialogue/stage1-store.service.ts` | Maintain the client profile, find a closed application, and create the linked application without reviving history. |
| `apps/api/src/dialogue/dialogue-orchestrator.service.ts` | Route a detected repeat-loan turn to the new application before model and stage evaluation. |
| `apps/api/src/dialogue/agent-turn.contracts.ts` | Allow the model to expose the non-durable repeat-loan detection signal. |
| `apps/api/src/dialogue/agent-turn.service.ts` | Carry the detection signal without persisting it as a client fact. |
| `apps/api/src/ai/prompts/agent.system.md` | Tell the extractor to identify new-loan repeat wording and not redirect it as servicing an active contract. |
| `apps/api/src/dialogue/repeat-loan.spec.ts` | Unit-test wording and fact boundaries. |
| `apps/api/src/dialogue/stage1-store.service.spec.ts` | Test profile hydration, old-application preservation, and one new application. |
| `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts` | Test end-to-end server routing, response, and ID-versus-STS behaviour. |

### Task 1: Define repeat-loan state and pure boundaries

**Files:**
- Modify: `packages/business-rules/src/index.ts`
- Create: `apps/api/src/dialogue/repeat-loan.ts`
- Test: `apps/api/src/dialogue/repeat-loan.spec.ts`

- [ ] **Step 1: Write failing unit tests for repeat wording and fact selection**

```ts
expect(isRepeatLoanRequest("Хочу снова займ под ту же машину")).toBe(true);
expect(isRepeatLoanRequest("Где оплатить действующий займ?")).toBe(false);
expect(persistentClientFacts(previous)).toEqual({
  fullName: "Иванов Иван Иванович",
  phone: "+996555000000",
  residenceRegion: "Бишкек",
  familyStatus: "single",
  documents: { id_front: "received", id_back: "received" }
});
expect(persistentClientFacts(previous)).not.toHaveProperty("vehicleMake");
expect(persistentClientFacts(previous).documents).not.toHaveProperty("vehicle_registration_front");
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run: `pnpm exec vitest run apps/api/src/dialogue/repeat-loan.spec.ts`

Expected: FAIL because `repeat-loan.ts` does not exist.

- [ ] **Step 3: Add the minimal pure repeat-loan module and business-rule stage**

```ts
export const repeatLoanIntent = "repeat_loan";
export function isRepeatLoanRequest(text: string): boolean { /* bounded Russian patterns */ }
export function persistentClientFacts(facts: ApplicationFacts): Partial<ApplicationFacts> { /* only identity, registration, family and ID sides */ }
export function repeatLoanFacts(profile: Partial<ApplicationFacts>): ApplicationFacts {
  return { ...profile, repeatLoan: true, documents: onlyReceivedIdDocuments(profile.documents) };
}
```

Extend `ApplicationFacts`, the stage union and `evaluateApplication()` so `repeatLoan` begins at `COLLECTING_VEHICLE` and document requirements still include fresh `vehicle_registration_front`, `vehicle_registration_back`, and `car_photo`.

- [ ] **Step 4: Run the unit test and package typecheck**

Run: `pnpm exec vitest run apps/api/src/dialogue/repeat-loan.spec.ts && pnpm --filter @ailyn/business-rules build`

Expected: both commands exit 0.

### Task 2: Persist client facts and create a new application from a closed one

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_closed_application_state/migration.sql`
- Modify: `apps/api/src/dialogue/stage1-store.service.ts`
- Test: `apps/api/src/dialogue/stage1-store.service.spec.ts`

- [ ] **Step 1: Write failing store tests**

```ts
const created = await service.createRepeatLoanApplication(conversation, closedApplication);
expect(created.id).not.toBe(closedApplication.id);
expect(created.facts).toMatchObject({ fullName: "Иванов Иванов", residenceRegion: "Бишкек", familyStatus: "single" });
expect(created.facts.documents).toEqual({ id_front: "received", id_back: "received" });
expect(created.facts).not.toHaveProperty("vehicleMake");
expect(created.facts.documents).not.toHaveProperty("vehicle_registration_front");
expect(closedApplication.state).toBe("CLOSED");
```

- [ ] **Step 2: Run the store test and verify it fails**

Run: `pnpm exec vitest run apps/api/src/dialogue/stage1-store.service.spec.ts`

Expected: FAIL because the repeat-application API and `CLOSED` state are absent.

- [ ] **Step 3: Implement server-owned profile and repeat application creation**

Add `CLOSED` to Prisma and business-rule state enums, then create and apply a Prisma migration. In `updateFacts()`, project only durable facts to `Contact.metadata.clientProfile`; do not save vehicle, loan, visit or STS facts there. Add methods that locate the most recent `CLOSED` application for the conversation contact and create a new application with metadata `{ status: "need_more_data", previousApplicationId }`, then write `persistentClientFacts()` into it. Record an audit event named `application.created_after_closed_loan`.

- [ ] **Step 4: Run store tests and regenerate Prisma client**

Run: `pnpm --filter @ailyn/api prisma:generate && pnpm exec vitest run apps/api/src/dialogue/stage1-store.service.spec.ts`

Expected: both commands exit 0.

### Task 3: Detect and route a repeat-loan turn before the AI workflow

**Files:**
- Modify: `apps/api/src/dialogue/agent-turn.contracts.ts`
- Modify: `apps/api/src/dialogue/agent-turn.service.ts`
- Modify: `apps/api/src/ai/prompts/agent.system.md`
- Modify: `apps/api/src/dialogue/dialogue-orchestrator.service.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Write failing orchestrator tests for accepted repeat-loan phrases**

```ts
expect(store.createRepeatLoanApplication).toHaveBeenCalledWith(conversation, closedApplication);
expect(store.updateFacts).toHaveBeenCalledWith(expect.objectContaining({ id: "new-app" }), expect.not.objectContaining({ vehicleMake: "Toyota" }));
expect(result.application.id).toBe("new-app");
expect(result.reply).toContain("оформляем новую заявку");
expect(result.reply).toContain("актуальные фото автомобиля и СТС с обеих сторон");
expect(result.reply).not.toMatch(/ФИО|прописан|семейн/i);
```

Also cover `«Займ снова дадите?»`: the response explains that a new application is possible and final approval follows vehicle/document verification, then continues the vehicle/STS stage. Add negative tests proving an active-contract payment request cannot create a repeat application and a self-reported payoff without a server-side `CLOSED` application cannot create one.

- [ ] **Step 2: Run the focused orchestrator tests and verify they fail**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "repeat loan"`

Expected: FAIL because repeat turns still use the latest application or active-contract redirect.

- [ ] **Step 3: Implement deterministic pre-routing**

Before money normalization and `agent.run()`, find a closed application for the contact. If it exists and `isRepeatLoanRequest(text)` is true, call `createRepeatLoanApplication()` exactly once, replace the current application/facts with the returned application, and use an explicit server reply-plan acknowledgement. Keep `existingContractQuestion` reserved for actual servicing requests. Include the closed application only as non-authoritative historical context; do not merge vehicle, STS, amount, programme, visit, approval or prior stage into current facts.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts -t "repeat loan"`

Expected: exit 0 with all new repeat-loan tests passing.

### Task 4: Verify full regression coverage

**Files:**
- Test: `apps/api/src/dialogue/repeat-loan.spec.ts`
- Test: `apps/api/src/dialogue/stage1-store.service.spec.ts`
- Test: `apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts`

- [ ] **Step 1: Re-read the requirements against tests**

Verify the tests explicitly prove: a new application is created; the old is still `CLOSED`; known ID, registration and family status are retained; current vehicle, STS, car photos, amount and programme are not retained; same-car wording is accepted but triggers current collateral collection; no approval promise is made; active service traffic cannot enter this branch.

- [ ] **Step 2: Run the full relevant test suite and typecheck**

Run: `pnpm exec vitest run apps/api/src/dialogue/repeat-loan.spec.ts apps/api/src/dialogue/stage1-store.service.spec.ts apps/api/src/dialogue/dialogue-orchestrator.service.spec.ts && pnpm --filter @ailyn/api typecheck`

Expected: both commands exit 0.

- [ ] **Step 3: Inspect the diff for unrelated changes**

Run: `git diff --check && git diff -- apps/api/prisma/schema.prisma packages/business-rules/src/index.ts apps/api/src/dialogue/repeat-loan.ts apps/api/src/dialogue/stage1-store.service.ts apps/api/src/dialogue/dialogue-orchestrator.service.ts apps/api/src/dialogue/agent-turn.contracts.ts apps/api/src/dialogue/agent-turn.service.ts apps/api/src/ai/prompts/agent.system.md`

Expected: no whitespace errors and only the planned implementation edits.

- [ ] **Step 4: Request independent code review and address Critical or Important findings**

Review against this plan and the source requirement, then rerun Step 2 after every fix.

## Self-review

- Spec coverage: Task 1 isolates repeat intent and separates persistent versus loan facts. Task 2 makes closed history and a client profile durable. Task 3 creates and routes a new application only after a server-confirmed closure, collects current collateral, and responds to both named phrase families. Task 4 verifies all listed acceptance points and negative conditions.
- Placeholder scan: the migration directory uses its generated timestamp by Prisma convention; no implementation decision is deferred.
- Type consistency: `CLOSED`, `repeatLoan`, `isRepeatLoanRequest`, `persistentClientFacts`, and `createRepeatLoanApplication` are the names used consistently across tasks.
