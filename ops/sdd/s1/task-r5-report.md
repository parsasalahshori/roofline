# S1 Task R5 report: landing page and doors polish

Branch `s1-r5` (from `s1-storm` c5e8144). API and db only.

## What changed

1. **One landing-code rule.** `STORM_PAGE_CODE_RE` (`/^[a-z2-7]{8}$/i`) is exported from
   `packages/db/src/repos/storm-pages.ts`, next to `newStormPageCode`, and used by `public/storm-page.ts` and
   `public/storm-requests.ts` (the POST route used to accept `[a-z0-9]{1,32}`). The two test fixtures
   `k7m2p9qa` and `bq4t8w2z` had characters outside the alphabet; they are now `k7m2p5qa` and `bq4t7w2z`.
2. **Form-friendly errors.** `publicRateLimit()` and the Origin guard moved from `app.ts` into
   `stormRequestRoutes`, so the router's `browserFormErrors` sees the public limiter's 429. That handler now also
   maps body-parser errors (too large, unreadable, unsupported charset) to `303 /storm/<code>?error=invalid`
   (new `invalid` key in `STORM_FORM_ERRORS`, sentence "We couldn't read that request..."). A 429 from either
   limiter is `?error=busy`. JSON posts keep JSON (429, 413, 400). Nothing outside the storm routes changed.
3. **createJob.** `createJob` already accepted `stormId`, `nextStep` and `nextStepOn` on this base (C1/R-series
   work), so no change to jobs.ts was needed and no other caller is affected. `createStormRequest` now calls it
   instead of inserting the job, audit row and activity rows by hand. The context is the system context
   (`userId: null`, role `system`), so the audit actor is null and the activity actor type is `system`, as before;
   `createdByUserId` stays null. `storm/doors.ts` already used `createJob`; nothing to change there.
4. **Doors tidy.** `placeFor(stop, company)` is synchronous and takes no tx/ctx; the fallbacks are the constants
   `FALLBACK_CITY`, `FALLBACK_STATE`, `FALLBACK_ZIP` and `nearLabel()`.
5. **Owner-visible note.** Matching behaviour: the typed address is looked up by its normalized key. If it is
   already another customer's home, the job and the request attach to that customer, and the phone customer
   stays as its own record. The job always gets the line "Storm inspection request from the storm page" (kept
   from before; `createJob` also writes "Job created"). When it attached to another customer's home the line
   reads "Storm inspection request from the storm page, sent for this home by <name>" and its data holds
   `requestedByCustomerId`. The public response never names any customer.

## Tests

- `packages/db/test/storm-requests.test.ts`: audit row and timeline lines for a landing-page lead (system actor);
  attached-to-existing-home line.
- `packages/db/test/storm-pages.test.ts`: generated codes pass `STORM_PAGE_CODE_RE`, bad shapes do not.
- `apps/api/test/storm-requests.test.ts`: malformed codes are 404 (JSON and form); public limit 429 as form
  (`?error=busy`) and JSON; per-IP limit as form; 413 and unreadable urlencoded (`?error=invalid`); 413 and
  malformed JSON stay JSON.
- `apps/api/test/storm-page.test.ts`: malformed codes give the generic 404 page.
- Local: typecheck and lint pass. db/api suites need Docker and run only in CI.

## CI

Green: run 38255682720 on 5e75615 (Platform, E2E, Hail and v1 all success). The first run (38252140351, b3a3c8e)
failed on two tests of mine: the malformed-code test sent a foreign-shaped Origin (the Origin guard answers 403
first), and `storm-skeleton` posted to code `x`, which the new rule now refuses with 404. Both tests fixed.
