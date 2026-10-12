### Task P3a (n 103): F3 polish: unlocated sign-up, early-report prune, small fixes

**Base:** `f3-setup` at `2d4158e` (F3 Tasks 1–6, 8–17, 21–23 and `f2-shell` through `aaee7a9`). Branch `f3-p3a`.
**Source:** ledger `ops/sdd/f3/progress.md`: Ruling AN; the parked `early_delivery_reports` prune; the G2 and T9 deferred minors; the T6 "20,000" minor.
**Parallel hazard:** other F3 tasks run at the same time (T24 imports, T25–T30 texting/billing). Touch only the files listed here. Never touch `package-lock.json`, `imports/{normalize,plan,run}.ts`, `hooks/**` or `messaging/**`. Anything that imports from `apps/api/src/jobs/queue.ts` imports types only (`import type`), because a value import makes an ESM cycle through `JOB_HANDLERS`.
**Migration number:** this task adds `0012`. If `f3-setup` already has a `0012_*` when this merges, the controller renumbers it.

**Split:**
- **Builder 1: geocoding (Ruling AN, item 4).** Files:
  - `apps/api/src/providers/{geocoder,geocodio}.ts`, `apps/api/src/providers/fakes/geocoder.ts`
  - `apps/api/src/company/location.ts`, `apps/api/src/auth/routes.ts` (only `createCompanyAccount`, its doc comment and the `ADDRESS_NOT_FOUND_MESSAGE` constant), `apps/api/src/routes/company.ts` (only the `NOT_FOUND_MESSAGE` constant and its use)
  - Tests: `apps/api/test/signup-company.test.ts`, `apps/api/test/geocodio.test.ts`, `apps/api/test/fakes.test.ts`
- **Builder 2: the early-report prune (item 2) and the worker comment (item 6).** Files:
  - `packages/db/migrations/0012_early_reports_prune.sql` plus the drizzle `meta/_journal.json` and `meta/0012_snapshot.json`. Generate them with `npx drizzle-kit generate --custom --name early_reports_prune` from `packages/db`, then fill in the SQL. Never hand-edit an older migration.
  - `packages/db/src/system/delivery-prune.ts` (new) and `packages/db/src/system/index.ts` (one export line)
  - `apps/api/src/jobs/scheduler/prune-early-reports.ts` (new), `apps/api/src/jobs/worker.ts` (one `SCHEDULES` line and its import)
  - `apps/worker/src/index.ts` (header comment only)
  - Tests: `apps/api/test/prune-early-reports.test.ts` (new), `apps/api/test/pgboss.test.ts` (the schedule list and count), and `packages/db/test/hardening.test.ts` / `migrations.test.ts` only if they enumerate app_system grants or policies
- **Builder 3: small fixes (items 3, 5, 7).** Files:
  - `apps/api/src/billing/read-only.ts`, `apps/api/src/jobs/queue.ts`, `apps/api/src/imports/parse.ts`
  - Tests: `apps/api/test/read-only-guard.test.ts` (new, no database), `apps/api/test/jobs.test.ts` (InlineJobs block only)

**Interfaces and requirements:**

1. **Ruling AN: sign-up with an address that can't be placed creates the account unlocated (Builder 1).**
   - `providers/geocoder.ts`:
     - The interface method becomes `geocode(address: string, opts?: { timeoutMs?: number }): Promise<GeocodeResult | null>`.
     - `geocodeMany` is unchanged.
     - `UnconfiguredGeocoder.geocode` accepts and ignores the parameter.
   - `providers/geocodio.ts`:
     - `geocode` uses `opts?.timeoutMs ?? this.timeoutMs` for that one request; the constructor default stays `DEFAULT_TIMEOUT_MS = 8000`, which batch imports use.
     - A timeout still throws `GeocoderUnavailableError`.
     - Make `request` take the timeout as a parameter; this is the smallest change.
   - `providers/fakes/geocoder.ts`: `geocode(address, opts?)` records `args: [address, opts]` in `calls` and otherwise ignores `opts`.
   - `company/location.ts`:
     - `export const ADDRESS_NOT_FOUND_MESSAGE = "We couldn't find that address. Check the street, city and state.";` This is the one shared constant.
     - `export const SIGNUP_GEOCODE_TIMEOUT_MS = 2000;`
     - `locateAddress(geocoder, text, opts?: { timeoutMs?: number })` passes `opts` to `geocode`.
   - `routes/company.ts`: delete the local `NOT_FOUND_MESSAGE` and use `ADDRESS_NOT_FOUND_MESSAGE` (same text, so the `/locate` 400 is unchanged).
   - `auth/routes.ts`, `createCompanyAccount`:
     - Call `locateAddress(deps.geocoder, details.addressText, { timeoutMs: SIGNUP_GEOCODE_TIMEOUT_MS })`.
     - `not_found` no longer throws. It takes the same path as `unavailable`: the company is made with the typed address, no point, no time zone and no service area.
     - Delete the local `ADDRESS_NOT_FOUND_MESSAGE`.
     - Update the doc comment: the owner places the company later through Setup and `POST /api/company/locate`.
     - Low accuracy and a 422 already come back as `null` from Geocodio, so they follow the same path.
   - Do not add a `Located` type (Ruling AN: only if something consumes it).
   - Tests:
     - `signup-company.test.ts`: replace `"an address we can't find is a field error and creates nothing"` with `test("an address we can't find still creates the account, unlocated")`. Use the same `1 Nowhere Rd, Omaha, NE 68102` sign-up. Expect status 201, then by SQL `location is null`, `address_street` equal to the typed text, and the time zone at the column default.
     - Same file: `test('sign-up gives the map 2 seconds')`. Pass a `FakeGeocoder` in through `makeTestApp` overrides if the file does not already reach it (`t.geocoder`). The last `geocode` call's `args[1]` equals `{ timeoutMs: 2000 }`.
     - `geocodio.test.ts`: `test('a per-call timeout overrides the default')`. Use a `GeocodioGeocoder` with the default timeout and a `fetch` that resolves only when its `signal` aborts (it rejects on abort). `geocode('x', { timeoutMs: 20 })` rejects with `GeocoderUnavailableError` within 1 s.
     - `fakes.test.ts`: covers item 4 (below).
   - The test files that keep their own `NO_ADDRESS = "We couldn't find that address."` (`jobs.test.ts`, `rep-visibility.test.ts`, `routes/jobs.ts`) cover the F1 job-address message. That is a different message: leave them alone.

2. **Prune of early delivery reports (Builder 2).**
   - Migration `0012_early_reports_prune.sql`, with statement breakpoints like 0011:
     ```sql
     GRANT SELECT (id, received_at, applied_at), DELETE ON early_delivery_reports TO app_system;
     --> statement-breakpoint
     CREATE POLICY app_system_all ON early_delivery_reports FOR ALL TO app_system USING (true) WITH CHECK (true);
     ```
     Comment why, in 0011's style: app_system prunes stale unapplied reports across companies; the policy is required because the table forces RLS.
   - `packages/db/src/system/delivery-prune.ts`: `export async function pruneEarlyDeliveryReports(system: Db, cutoff: Date): Promise<number>` deletes rows where `applied_at is null and received_at < cutoff` and returns the count. Export it from `system/index.ts`.
   - `apps/api/src/jobs/scheduler/prune-early-reports.ts`:
     - `export const EARLY_REPORT_MAX_AGE_DAYS = 7;`
     - `export async function pruneEarlyReports(deps: AppDeps, now: Date): Promise<void>` calls `pruneEarlyDeliveryReports(deps.pools.system, new Date(now.getTime() - 7 * 86_400_000))`. Errors propagate, like `endTrials`'s fan-out query.
   - `jobs/worker.ts` `SCHEDULES`: append `{ name: 'prune-early-reports', cron: '17 3 * * *', run: pruneEarlyReports }` (daily at 03:17 UTC).
   - Tests:
     - `prune-early-reports.test.ts` (`makeTestApp`; insert rows by owner SQL through a `pg.Client` on `inject('dbUrls').owner`, as `setup.test.ts` / `twilio-hooks.test.ts` do):
       - Company A: an unapplied report received 8 days before `now` (deleted), an unapplied one 6 days old (kept), an applied one 8 days old (kept).
       - Company B: an unapplied one 8 days old (deleted).
       - After `pruneEarlyReports(t.deps, now)`, the remaining ids are exactly the two kept rows. A second run deletes nothing.
     - `pgboss.test.ts`: the schedule list and count include `prune-early-reports` (9 schedules).
     - If `packages/db/test/hardening.test.ts` or `migrations.test.ts` lists app_system's grants or policies, add the new ones.

3. **Read-only allowlist accepts the bare paths (Builder 3).**
   - `billing/read-only.ts`: a path is open when, for one of `auth`, `billing` and `me`, it equals `'/' + name` or starts with `'/' + name + '/'` (lowercased, as now).
   - `'/billingx'` and `'/merge'` stay refused.
   - Tests in `read-only-guard.test.ts` (pure: call `readOnlyGuard(req, res, next)` with plain objects; `res.status().json()` records its arguments; no database):
     - `trial_ended` with `POST` to `/billing`, `/me`, `/auth/logout` and `/billing/checkout` calls `next`.
     - `POST /billingx` and `POST /customers` answer 403 with `READ_ONLY_MESSAGE.trial_ended`.
     - `GET /customers` calls `next`.
     - No session calls `next`.

4. **FakeGeocoder sets the city for two-part addresses (Builder 1).**
   - `parseAddress`:
     - Two parts: when the last part matches the `ST zip` / `ST` tail pattern, it is state and zip and the city is null. Otherwise the second part is the city.
     - So `'1 A St, Omaha'` gives city `'Omaha'`, and `'1 A St, NE 68102'` gives state `'NE'`, zip `'68102'` and city null.
     - Three or more parts are unchanged.
   - Tests in `fakes.test.ts`: those two cases, plus the existing three-part case still passes.

5. **InlineJobs dedupes per queue (Builder 3).**
   - `jobs/queue.ts` `InlineJobs.send`: a send is a duplicate only when a waiting job has the same `name` and the same `singletonKey`.
   - Test in `jobs.test.ts`, InlineJobs block: `'the same singletonKey on two queues runs both'`. `import-customers` and `texting-registration` both sent with key `'k'`: `sent` has 2 entries and both handlers run once.

6. **Worker header comment (Builder 2).** `apps/worker/src/index.ts`:
   - Rewrap the header at the repo's usual width.
   - Say texts go through `deps.sms` from `createSmsAdapter` (the fake, Twilio, or the disabled adapter).
   - Say the recurring jobs are `SCHEDULES` (point to `jobs/worker.ts` instead of listing three).
   - No code change.

7. **The import row limit text comes from `MAX_IMPORT_ROWS` (Builder 3).** `imports/parse.ts`:
   - Build the too-many-rows message from `MAX_IMPORT_ROWS.toLocaleString('en-US')`.
   - The text stays exactly "This file has more than 20,000 rows. Split it into smaller files and import each one."
   - The existing tests stay unchanged.

**Verify:** `ops/bin/slot npm run typecheck && ops/bin/slot npm run lint`. The api and db suites need Docker, which this box doesn't have, so they run on GitHub through `ops/bin/ci-check`. The new `read-only-guard.test.ts` and `fakes.test.ts` start no database and may run locally as focused files.

**Commit:** `fix(api): unlocated sign-up for unplaceable addresses, prune stale early reports, small F3 fixes`
