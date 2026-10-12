### Task 28: End-to-end tests, acceptance map, docs

**Base:** `s1-storm` after Tasks 8–27 are merged. Real/F3: `apps/web/e2e/{stack,fixtures}.ts`; **[C1]** C1 T28 and **[E1]** E1 T21 e2e additions (`seedFootprintFixture`).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Files:** Create `apps/web/e2e/{storm,doors}.spec.ts`, `docs/superpowers/s1-acceptance.md`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `README.md` (hail service, Google/Meta/Postmark broadcast env, `app_hail`), and the e2e reset to seed a fixture storm over the Omaha showcase through a new `seedStormFixture(pools)` exported from `apps/api/src/index.ts` (add the export here) plus active fake ad accounts.
- **Tests:** `test('storm plan in 2 clicks')` — owner, Storm window → "Approve storm plan" → review → Approve: all five steps Done with the fakes, results show texts sent and two campaigns; `test('office approves messages, owner approves spend')`; `doors.spec.ts` (phone project) — rep opens My routes, marks a door "Wants a check", the lead appears on the owner's Today; landing page on phone submits a request; a11y on `/storm`, `/storm/:id`, the route view and the landing page; phone no-scroll on the route view and landing page.
- **`s1-acceptance.md`:** every spec §12 bullet → its tests (Python ones included).

**Carries and rulings:**
- Plan Ruling 11: the hail worker, match timing and ad sync are proven by pytest and integration tests, not e2e.

**Verify notes:**
- typecheck, lint, `npx playwright test --list`; CI via `ci-check`.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(e2e): storm plan in 2 clicks, doors on a phone, S1 acceptance map`
