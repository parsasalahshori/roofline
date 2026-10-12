### Task R7 (whole-branch review follow-ups): merged storms everywhere, alert wiring, ops config (Ruling BE)

**Base:** `s1-storm` after R1, R2a and R2b merged. API, db and the hail service.

**Fixes:**
1. **(important) Merged storms are hidden everywhere.** R1 sets `storms.merged_into` but filters only the matching queries. Add `s.merged_into is null` (joining storms where needed) to:
   - `listCompanyStorms` and `getCompanyStormSummary` in `packages/db/src/repos/storm-api.ts`;
   - the company-storm reads in `packages/db/src/repos/storm-alerts.ts`, including `listUnalertedMatched`;
   - storm settle candidates, if they read storms.
   Decide what happens to a `company_storms` row whose storm was merged:
   - **before a plan exists:** it disappears from lists and alerts;
   - **after a plan exists:** keep it visible, and record the decision in the report.
   Add db tests: a merged storm is not listed, alerted or drafted.
2. **(important) Wire `alertUnalerted` into the match.** `afterMatch` in `apps/api/src/storm/settle.ts` calls `alertUnalerted(deps, companyId)` once, replacing the per-id `alertNow` loop over `result.created`. Bound `listUnalertedMatched` to recent rows (`created_at > now() - interval '3 days'`), so a release never emails about stale storms.
3. **Ruling BE (launch runbook 1.10):** everything in `ops/sdd/s1/task-r6-brief.md` (folded in here; there is no separate R6):
   - `POSTMARK_TOKEN` in the hail service, with `POSTMARK_SERVER_TOKEN` as a fallback;
   - document `OPS_ALERT_EMAIL` (it must be a verified Postmark sender);
   - hail-health thresholds come from config;
   - the README line saying `POLICY_PAGES_DOMAIN` is required.
4. **(minor, from R1) Hail service:**
   - `_closing_key`: require the exact `12:00:00` 1440min key until 12:20Z, then fall back to the last key at or before 12:00.
   - A 60min grid valid at exactly D+1@12:00:00 is filed under day D (`convective_day(valid_at - 1s)`).
   - In replace (final) mode, skip `_MERGE_GEOM`/`_MERGE_CONTOURS` (still set `merged_into`).
   - Give up on closing a day after 3 days without its 1440min key, with a warning.
   - Add a `test_run` case with a real 60min key so the after-key cursor is exercised.

**Verify:** typecheck, lint, the shared tests, the Python syntax parse, and drizzle-kit reporting no changes; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(storm): merged storms hidden everywhere, unalerted storms retried at match time, ops config from env`
