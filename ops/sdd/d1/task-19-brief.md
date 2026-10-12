### Task 19: Wiring the tools and the full call path

**Base:** `d1-front-desk` after Tasks 7, 8, 9 and 11 are merged. From T6: `ToolHandler`, `ToolContext`. From T7–T9: each tool's handler export.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `tools/index.ts` (the handler map, filtered by channel and settings; tool descriptions from shared); Builder 2 relay ↔ engine ↔ tools in one integration test per scenario (booking, job question verified, claim, message, transfer leak, angry, recording objection, spam) using `FakeVoiceSession` + `ScriptedLlm`; Builder 3 fix-ups found by those tests inside Tasks 6–11 files (owner of the file's task reviews).

**Files:** Fill `apps/api/src/front-desk/tools/index.ts`; Create `apps/api/test/front-desk/call-paths.test.ts`.

**Tests:**
- each scenario reaches its outcome, records turns with timings, creates the right records, and ends with the right TwiML/handoff.

**Carries and rulings:**
- `front-desk/tools/index.ts` is edited only here.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk end to end on the server — calls through the engine and its tools`
