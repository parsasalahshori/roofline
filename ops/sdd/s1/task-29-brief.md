### Task 29: Manual smoke: real MESH, Google and Meta test accounts, a broadcast email

**Base:** `s1-storm` after Tasks 3, 13, 17 and 18 are merged. Pattern: F3 T37 `assertConfirmed`; **[C1]** C1 T29 and **[E1]** E1 T22 smoke layout.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Files:** Create `apps/api/src/scripts/smoke/storm.ts`, `docs/superpowers/s1-manual-smoke.md`, `apps/api/test/smoke-storm-guards.test.ts`; Modify `apps/api/package.json` (`smoke:storm`).
- `smoke:storm --confirm-real-providers [--google <testCustomerId>] [--meta <testAdAccountId>] [--email <address>]`: Google — link status, account info and one **paused** campaign in a **test account** (refused unless the account is a Google Ads test account or `--i-understand-spend` with a $1 budget and immediate removal); Meta — verify access, upload the card image, one **paused** campaign then delete it; one broadcast email with a working unsubscribe. The hail worker runbook: run `python -m hail.main --once` against staging and compare with the NOAA MRMS viewer for the same time. Prints no secrets; the captured API responses replace Task 17/18 fixtures (scrubbed).

**Carries and rulings:**
- Never run `smoke:*` in automation.
- **Python (no local runs on the build box):** the hail runbook's `python -m hail.main --once` runs only on staging, by hand; CI runs them in the `hail` job (Ruling SC) — prove with `CI_JOBS="Platform Hail" ops/bin/ci-check`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(smoke): real MESH run, Google and Meta test campaigns and a broadcast email, by hand only`
