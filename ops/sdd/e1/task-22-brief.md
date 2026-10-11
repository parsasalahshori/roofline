### Task 22: Manual smoke: EagleView sandbox, R2, a real text

**Base:** `e1-estimator` after Tasks 9, 10 and 13 are merged. Pattern: F3 T37's `assertConfirmed(argv, flag)` and **[C1]** C1 T29's `smoke:calendar` script layout.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Files:** Create `apps/api/src/scripts/smoke/estimator.ts`, `docs/superpowers/e1-manual-smoke.md`, `apps/api/test/smoke-estimator-guards.test.ts`; Modify `apps/api/package.json` (`smoke:estimator`).
- `smoke:estimator --confirm-real-providers [--eagleview-sandbox] [--r2] [--sms <E.164>]`: EagleView sandbox token, Property Data on a documented Omaha address, PriceOrder (sandbox) — never PlaceOrder unless `--place-order` (costs money in production; refused unless `EAGLEVIEW_ENV=sandbox`); R2 put/get/delete of a test object; one real proposal text to the given test phone through the real send path on staging. Prints no secrets.
- **Runbook:** each check, its command and expected result; footprints for one real state loaded on staging (time and size recorded); a sign-off table.

**Carries and rulings:**
- Never run `smoke:*` in automation; never `PlaceOrder` outside the sandbox.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(smoke): EagleView sandbox, R2 and a real proposal text, by hand only`
