### Task R6 (Ruling BE, launch runbook 1.10): ops config for hail alerts

**Base:** `s1-storm` after R1 and R2b merge. Those tasks edit `services/hail/hail/main.py` and `apps/api/src/jobs/scheduler/hail-health.ts`; build on their merged versions.

**Fixes:**
1. **One Postmark token name.** The hail service reads `POSTMARK_SERVER_TOKEN`; the API reads `POSTMARK_TOKEN`. Unify on `POSTMARK_TOKEN`:
   - `services/hail/hail/main.py` reads `POSTMARK_TOKEN`, falling back to `POSTMARK_SERVER_TOKEN` with a deprecation log line;
   - update `services/hail/README.md` (the Render setup), the tests (`tests/test_main.py`), and the root README / `.env.example` if they mention the old name.
2. **OPS_ALERT_EMAIL.** Document it in the API config schema (`apps/api/src/config.ts`: the describe or comment next to its zod field) and in `.env.example`. It must be a verified Postmark sender address (the From domain must be verified in Postmark). Same note in `services/hail/README.md`.
3. **Stale thresholds from config.** `hail-health.ts` hard-codes 180/720 minutes (a season switch). Derive them from config: `HAIL_STALE_MINUTES` (default 90, the storm-layer banner) and a new `HAIL_ALERT_STALE_MINUTES_SEASON` / `HAIL_ALERT_STALE_MINUTES_OFFSEASON` (defaults 180 / 720) in `config.ts` with zod.
   - Document them in `.env.example` and the README.
   - Unit tests for the config defaults and overrides (`apps/api/test/storm-config.test.ts`) and for the threshold function.
4. **No landing domain.** Item 4 of Ruling BE is already done by I5 (the ad step fails before any spend without `POLICY_PAGES_DOMAIN`). Add a line to the README's Storm Scout section saying `POLICY_PAGES_DOMAIN` is required for storm landing pages and ads.

**Verify:** typecheck, lint, Python syntax parse; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `chore(storm): one Postmark token name, documented ops alert sender, stale thresholds from config`
