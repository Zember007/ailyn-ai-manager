# Document vision reliability — implementation plan

**Goal:** Reliably classify every uploaded image as an ID side, vehicle-registration certificate (STS) side, car photo, poor-quality image, or unknown; always run a dedicated document OCR pass to search for client and owner FIO.

**Architecture:** Keep the conversational model for dialogue, but make a narrow vision pass the authoritative source for image attachment types and document-derived names. The pass returns one classification keyed by every attachment ID, plus FIO values. Its result is merged into the turn result before attachments and facts are persisted. Legacy aggregate document flags remain readable for backward compatibility.

## Steps

- [x] Add a focused regression proving that a vision response maps ID, STS, car and unknown images to their individual attachment IDs and persists names/document facts.
- [x] Expand the vision JSON contract and prompt: require exactly one classification per supplied image, explicit category rules, and FIO search on every detected ID/STS.
- [x] Parse the keyed results defensively, merge them authoritatively with conversational attachment output, and retain legacy aggregate document flags as a fallback.
- [x] Run the focused dialogue tests, typecheck, and lint; record any pre-existing unrelated suite failures separately.

**Verification (2026-09-11):** The focused ID/STS/FIO tests (including the new per-image classification regression) pass; `pnpm --filter @ailyn/api typecheck` and `pnpm lint` pass. The full dialogue spec currently has 74 failures in the existing dirty worktree, so it is not a clean baseline for this focused change.
