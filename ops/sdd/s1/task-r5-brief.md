### Task R5 (whole-branch review): landing page and doors polish

**Base:** `s1-storm` (with R3). API and db only. Do NOT touch the files that R1, R2a and R2b are changing:
- services/hail;
- company-storms.ts, storm-hits.ts and storm-match-fanout.ts (matching);
- storm/plan.ts, settle.ts, routes/storms.ts, storm-plans.ts and storm-api.ts;
- replies.ts, storm-text.ts, send-batch.ts and tasks/service.ts;
- dispatch-email.ts, storm-results.ts, alerts.ts and hail-health.ts;
- migration 0018.

**Fixes:**
1. **One landing-code rule.** `public/storm-page.ts` accepts `/^[a-z2-7]{8}$/i`, but `public/storm-requests.ts` accepts `/^[a-z0-9]{1,32}$/`. Share one exported constant (where `ensureStormPage` generates codes) and use it in both. Test that a malformed code gets a 404 or 400 on both routes.
2. **No-JS visitors get a page, not JSON.**
   - `publicRateLimit()` sits outside the storm router's `browserFormErrors`, so a no-JS visitor who trips it gets a JSON 429. Body-parser errors (413, malformed) also fall through as JSON.
   - For urlencoded form posts, all of these redirect with `?error=busy` (or `?error=invalid`), just as the router's own errors do. JSON clients keep JSON.
   - Tests.
3. **Storm jobs go through createJob.**
   - `packages/db/src/repos/storm-requests.ts` inserts the Lead job directly, because `createJob` has no `stormId`/`nextStep` inputs. Extend C1's `createJob` (`repos/jobs.ts`) with optional `stormId`, `nextStep` and `nextStepOn`, keeping every existing caller unchanged.
   - Use it from storm-requests, and from `storm/doors.ts` if that one also inserts directly, so the audit and activity rows match the normal path.
   - Tests: the audit/activity row exists for a landing-page lead.
4. **Doors cleanup.** In `storm/doors.ts`, `placeFor` drops the unused `tx`/`ctx` and `async`, and its fallback literals ('Unknown', 'NE', '00000', 'Near lat, lng') become named constants.
5. **Owner-visible note.** When a landing-page request's typed address matches another customer's home, the request attaches to that customer. Make sure the owner can see it was a landing-page request (activity text), and record this behaviour in the report.

**Verify:** typecheck, lint, shared tests; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(api): one landing code rule, form-friendly errors, storm leads through createJob, doors tidy`
