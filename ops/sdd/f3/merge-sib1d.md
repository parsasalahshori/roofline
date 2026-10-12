# Merge notes: sibling 1, F3 P3a (branch f3-p3a)

Group check by Opus contact 27 (workflow run wf_acf5f180-996). Base f3-setup 2d4158e. Brief: ops/sdd/f3/task-p3a-brief.md.

## Merge notes

There is only one task in this batch (T103, branch f3-p3a, base 2d4158e, head 51375ed), so no tasks in it can conflict with each other. origin/f3-setup is still at 2d4158e, which is exactly T103's base, so merging f3-p3a into f3-setup is a clean fast-forward. I also checked the local branches f3-t9, f3-t16, f3-t21 and f3-t22: none of them touches the files T103 changes (migrations, auth/routes.ts, billing/read-only.ts, company/location.ts, jobs/, providers/, routes/company.ts, imports/parse.ts, worker index, db system index, rls/jobs/pgboss/signup/fakes tests).

Things to watch at merge time:
- **Migration 0012 (`0012_early_reports_prune`).** T103 takes migration number 0012. Its snapshot matches 0011 except for `id`/`prevId`, and `prevId` points at 0011's id, so the chain is valid. If another F3 branch also adds a 0012 migration later, the one merged second must be renumbered to 0013. It then needs its journal entry (idx 13, a later `when`) and a snapshot whose `prevId` is ea10ef01-05e7-4df6-bc89-e447570bcc27. Do not hand-merge `_journal.json`.
- **app_system grants on early_delivery_reports.** The migration gives app_system read access to `id`, `received_at` and `applied_at`, plus DELETE, and adds an `app_system_all` policy on the table. `rls.test.ts` was updated to match: the RLS table list, the table-privilege test, the allowed-column list, and a new test. Any later branch that changes app_system grants or the `APP_SYSTEM_RLS_TABLES` list must keep `early_delivery_reports` in it. The cross-company read test now leaves this table out on purpose with `Exclude<>`, because app_system cannot read `company_id`.
- **`Geocoder.geocode` signature.** It now takes an optional `opts?: { timeoutMs?: number }`, and FakeGeocoder records it as a second entry in `args`. Any later test that asserts `geocoder.calls` with `toEqual` needs the extra `undefined` or options entry.
- **`InlineJobs` duplicate check.** It now drops a duplicate only when both the queue name and the singletonKey match. A later test that expected the same key on two different queues to collapse into one job would now fail.
- **`SCHEDULES`.** `prune-early-reports` ('17 3 * * *') is now the last entry. A later branch that adds a schedule should go after it and update the order in jobs.test.ts and pgboss.test.ts.
- **Sign-up behaviour.** Sign-up no longer returns 400 on `companyAddress` for an address the map cannot place. It creates an unlocated company instead: no point, no service area, and the time zone left at the column default (`setCompanyLocation` skips a null time zone). No web copy or e2e test refers to the old message, so nothing on the web side has to change.
- **Copy and lint.** No JSX or web files changed. Imports use explicit `.ts` extensions. `TOO_MANY_ROWS_MESSAGE` now builds "20,000" from `MAX_IMPORT_ROWS` in `@roofline/shared`, imported at the top of parse.ts.
- **CI.** The database-backed tests (prune-early-reports, rls, signup-company, pgboss) must be run through ci-check, since they cannot run on this machine.

## Issues

- **minor**: The doc comment on the new ADDRESS_NOT_FOUND_MESSAGE in apps/api/src/company/location.ts says sign-up, Setup and the batch import all use it. After Ruling AN, sign-up no longer raises it, and imports never imported it. The only consumer is POST /api/company/locate in apps/api/src/routes/company.ts. apps/api/src/routes/jobs.ts still has its own shorter NO_ADDRESS string.
  - Suggestion: Change the comment to say the message is used by Setup's locate route, or drop the claim. Behaviour does not need to change.
- **minor**: The createCompanyAccount doc comment in apps/api/src/auth/routes.ts lists 'low accuracy' as a reason the map cannot place an address. That is correct only because GeocodioGeocoder returns null below MIN_ACCURACY or for an unaccepted accuracy_type; locateAddress does no accuracy check itself. Accurate today, but it depends on the provider.
  - Suggestion: Optional: say that low accuracy shows up as not found through the geocoder.
- **minor**: apps/api/test/prune-early-reports.test.ts opens a new owner pg.Client in beforeEach but closes only the last one in afterAll. There is only one test now, so nothing leaks yet, but adding a second test would leak a connection.
  - Suggestion: Switch to afterEach(() => owner.end()), or open the client once in beforeAll.
