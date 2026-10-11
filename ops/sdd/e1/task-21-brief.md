### Task 21: End-to-end tests, acceptance map, docs

**Base:** `e1-estimator` after Tasks 6–20 are merged. **[C1]** C1 T28's e2e additions (`crm.spec.ts`, `calendar.spec.ts`, the appended `phone.spec.ts`/`a11y.spec.ts`) and the stack with `FAKE_PROVIDERS=1`. Real (F2/F3): `apps/web/e2e/{stack,fixtures}.ts` (`loginAs`, `clicks`, `markTodaySeen`).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Files:** Create `apps/web/e2e/{estimator,homeowner}.spec.ts`, `docs/superpowers/e1-acceptance.md`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `apps/web/e2e/stack.ts` only if a new env is needed (`FAKE_PROVIDERS` already on), `README.md` (EagleView, R2, link base env; footprints loader note).
- **Fixtures:** the e2e reset seeds `building_footprint_states` NE `ready` and the fixture footprints (through a new `seedFootprintFixture(pools)` exported from `apps/api/src/index.ts` — add the export in this task).
- **Tests:** `test('typed address to sent in 3 clicks')` (owner; an Omaha showcase address; `clicks.count <= 3`; the review shows three totals; after Approve the step shows Done and the fake SMS adapter got a text containing `/p/` — check through the proposal view's status "Sent"); `test('exact report: owner approves the spend')` (the order reaches "Waiting for the report"; completion and re-pricing are Task 10's integration tests, Ruling 8); `homeowner.spec.ts` (phone project): open the link from the proposal view's Copy link, view, choose Better, sign with the keyboard only, see "Signed" and the download link, then the owner's job shows Won with the value; a11y on `/estimator`, the measure view, the proposal view and `/p/<token>`; phone no-scroll on the homeowner page and the proposal view.
- **`e1-acceptance.md`:** every spec §11 bullet → its tests.

**Carries and rulings:**
- **Ruling 8 (plan):** EagleView completion, aerial measure and footprint loading are proven by integration tests, not e2e.

**Verify notes:**
- typecheck, lint, `npx playwright test --list`; CI E2E via `ci-check`.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(e2e): address to sent in 3 clicks; the homeowner signs on a phone; E1 acceptance map`
