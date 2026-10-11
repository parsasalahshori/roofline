# Task 6 report: API: serve the web app, CSP, today-shown, rerun link, body limit

Status: DONE_WITH_CONCERNS (code complete, committed, every test file green; the one caveat is that the API suite ran in four batches against my own postgis container instead of one `npx vitest run`, because the machine was saturated).

Worktree: /Users/parsasalahshori-a/RooflineWork/wt/t6, branch `f2-t6`
Commit: `e86e649 feat(api): serve the web app with a map-ready CSP, today-shown, rerun link`

## What I implemented

- `packages/shared/src/time-zone.ts`: `localDate(now, zone)`, `Intl.DateTimeFormat('en-CA', { timeZone, year, month: '2-digit', day: '2-digit' })`. Exported through the package entry (already `export *`).
- `packages/db/src/system/me.ts` (exported from `system/index.ts`): `markTodayShown(system, companyId, userId, now)`.
  - One transaction: `select timezone from companies`, then ONE `update memberships m ... from companies c ... and m.status = 'active' and m.last_today_shown_on is distinct from $today::date returning m.id`.
  - Returns `rows.length > 0`. `updated_at = now()` as in the brief (Drizzle's own `$onUpdate` uses the real clock too).
  - Unknown company returns false.
- `apps/api/src/auth/me.ts`: `meRoutes(deps)`, `POST /today-shown` returns `{ show }` using `req.session.companyId/userId` (non-null, unlike `req.ctx.userId`). Mounted `app.use('/api/me', meRoutes(deps))` after `/api/auth`, behind the existing gate (not in the public allowlist, so no session means 401).
- `apps/api/src/web.ts`: `serveWeb(app, distDir)`.
  - `express.static(root, { index: false, setHeaders })`: files under `<root>/assets/` get `Cache-Control: public, max-age=31536000, immutable`; `index.html` asked for by name gets `no-cache`.
  - SPA fallback for GET/HEAD: not `/^\/(?:api|hooks|health)(?:\/|$)/i` (segment-aware and case-insensitive, because Express matches routes case-insensitively) and not `/\.[a-z0-9]+$/i`. It sends `index.html` with `Cache-Control: no-cache`. Anything else calls `next()`, so `notFoundHandler` gives the usual JSON 404 (also for `/assets/missing.js`).
- `apps/api/src/config.ts`: `WEB_DIST_DIR` optional. `fs.statSync` inside a zod `.refine` (directory + `index.html` file). The message is `WEB_DIST_DIR: must be a directory that contains index.html (build the web app first: npm run build:web)`. It never prints the path or any other value.
- `apps/api/src/app.ts`:
  - `helmet({ contentSecurityPolicy: { directives } })` with exactly the brief's directives. `upgradeInsecureRequests` is `[]` in production and `null` otherwise. Helmet's other defaults are kept (`script-src-attr 'none'`, HSTS, nosniff, etc.).
  - `app.use('/api/approvals', express.json({ limit: '1mb' }))` before the global 256 KB parser (exported constant `APPROVALS_JSON_BODY_LIMIT`).
  - `serveWeb` mounted only when `config.WEB_DIST_DIR !== undefined`, after the routers and before `notFoundHandler`.
- `apps/api/src/tasks/service.ts`: `TaskView.rerunOfTaskId: string | null` and `toTaskView` sets it. It is on the list, detail, action responses and the 409 `latest`, since they all go through `toTaskView`.
- `.env.example`: `APP_ORIGIN=http://127.0.0.1:4401` with the explanation (Vite's origin in development, the API's own URL in production), `WEB_DIST_DIR=` documented. `PUBLIC_BASE_URL` stays on 4400.
- `README.md`: new "Run it locally" section (after the intro, before "Running in production"), a `WEB_DIST_DIR` row in the production table, and a build step in the boot order.

## Tests written (TDD) and results

New or extended files:
- `packages/shared/test/time-zone.test.ts` (localDate: the two brief cases plus the Chicago midnight and daylight-saving boundaries)
- `apps/api/test/me.test.ts` (brief's four tests, plus: reps too, 6 concurrent requests give exactly one `show:true`, zone of the member's own company, DB value)
- `apps/api/test/web.test.ts` (all brief cases, plus HEAD, other files not immutable, file-looking paths 404, `/index.html` no-cache, hooks 404 JSON, POST to a page path is the JSON 404, production CSP has `upgrade-insecure-requests`, helmet's other headers, no-`WEB_DIST_DIR` still carries the CSP)
- `apps/api/test/config.test.ts` (`WEB_DIST_DIR`: unset/blank, accepted, relative path read from the repo root, missing dir names the key and prints no value, dir without `index.html`, file instead of dir)
- `apps/api/test/approvals-approve.test.ts` (`carries the plan it was rerun from` on rerun response, detail, list, ordinary and expired plan; `accepts an edit body over 256 KB on approvals` (400 `Please keep the label to 200 characters or fewer.`, field `payload...`); body over 1 MB on approvals is still 413 and 300 KB on `/api/customers` is still 413)
- `apps/api/test/approvals-edit.test.ts`: the one F1 test that `toEqual`s a whole TaskView got `rerunOfTaskId: null`.

RED (before implementing), `npx vitest run --project @roofline/shared` and `--project @roofline/api <the new files>`:
- shared: `FAIL time-zone.test.ts > localDate > is the calendar day in the zone, not in UTC: TypeError: localDate is not a function` (2 failed | 91 passed).
- api, `web.test.ts`: 9 failed (`expected 404 to be 200` for every served page and asset; CSP `expected 'default-src ...' to contain 'style-src ...'` / `worker-src 'self' blob:`).
- api, `config.test.ts`: 5 failed (`expected undefined to be '/var/folders/...'`, `Expected loadConfig to throw` x3).
- api, `me.test.ts`: 5 failed (`expected 404 to be 200`, `expected { error: "We couldn't find that." } to deeply equal { show: true }`); the `needs a session` test already passed because the gate answers 401 first.
- api, `approvals-approve.test.ts`: `expected undefined to be '<task id>'` (rerunOfTaskId) and `expected 413 to be 400` (300 KB body).

GREEN after implementing (same command, new + changed files plus all shared tests): `Test Files 10 passed (10), Tests 196 passed (196)`.

After the later edits (docs, approvals-edit fix), via my own container (see below):
- `approvals-edit -t "TaskView carries"`: 1 passed.
- `app.test`, `boundaries.test`, `config.test`: 3 files, 97 tests passed.
- `me.test`, `web.test`, `approvals-approve.test`: 3 files, 72 tests passed.
- `npx vitest run --project @roofline/shared`: 6 files, 93 tests passed.
- `npm run lint` and `npm run typecheck`: clean (run after the final code state, with the commit staged).

## Test status (the caveat)

- The machine was saturated while I worked: load average 200 to 350 (many parallel agents), every Testcontainers PostGIS container is amd64 under emulation, and my first two `npx vitest run --project @roofline/api --project @roofline/shared` attempts produced no output for 20+ minutes. Later attempts died in `globalSetup` with `Error: Health check not healthy after 180000ms`. Individual tests took 10 to 19 s each (a full run of ~1,050 API tests would be several hours).
- To get real results I started my OWN postgis container (`t6-pg`, `docker run`, no 180 s limit) and ran vitest with an untracked scratch config (`.t6-vitest.config.ts`, `.t6-global-setup.ts` in the worktree root; migrate + role passwords exactly as `packages/db/src/testing/global-setup.ts` does, then `provide('dbUrls', ...)`). These are not committed.
- Final coverage on the committed code (`e86e649`), all via that scratch setup, no failures:
  - batch 1: `approvals-edit -t "TaskView carries"` (1 test), `app` + `boundaries` + `config` (97 tests);
  - batch 2: `me` + `web` + `approvals-approve` (72 tests);
  - batch 3 (all remaining API files, 20 of them): `Test Files 20 passed (20), Tests 1172 passed (1172)`, 3,385 s. That includes the whole `approvals-edit`, `scheduler`, `runner`, `send-batch`, `isolation`, `permissions`, `team`, `auth-*`, `rep-visibility` (the F1 flake did not show up this time), `pgboss`, `seed-demo`, `twilio-hooks`.
  - So all 26 API test files passed on the final code (batches 1 to 3 together), plus `--project @roofline/shared` (6 files, 93 tests) separately.
- Why not one `npx vitest run --project @roofline/api --project @roofline/shared`: it was started twice and produced no output for 20+ minutes under the load (load average 200 to 350), and later runs died in the Testcontainers `globalSetup` with the 180 s health-check timeout. The scratch config files and the `t6-pg` container are removed; the worktree is clean (`git status` empty).

## Files changed (committed)

`.env.example`, `README.md`, `apps/api/src/app.ts`, `apps/api/src/auth/me.ts` (new), `apps/api/src/config.ts`, `apps/api/src/tasks/service.ts`, `apps/api/src/web.ts` (new), `apps/api/test/approvals-approve.test.ts`, `apps/api/test/approvals-edit.test.ts`, `apps/api/test/config.test.ts`, `apps/api/test/me.test.ts` (new), `apps/api/test/web.test.ts` (new), `packages/db/src/system/index.ts`, `packages/db/src/system/me.ts` (new), `packages/shared/src/time-zone.ts`, `packages/shared/test/time-zone.test.ts`.

## Self-review findings

- Decision beyond the brief (flag for review): a relative `WEB_DIST_DIR` is resolved against the repository root, and the config keeps the absolute path. Reason: `npm start -w @roofline/api` (the documented production command) and `npm run dev:api` run with cwd `apps/api` (I checked), so `WEB_DIST_DIR=apps/web/dist` read from the cwd would never exist. Absolute paths are unchanged. Covered by a test.
- Worker interaction: `apps/worker` uses the same `loadConfigOrExit`, so a worker started with `WEB_DIST_DIR` set also needs the built `index.html` or it refuses to start. The README says the API and the worker need the same set, and the production host has one checkout, so this should be fine; noted in `.env.example`.
- Unauthenticated `GET /api/nope` is a 401 JSON (the sign-in gate comes first), not 404. The brief's 404 case is tested signed in; the signed-out 401 is also asserted to be JSON.
- Pre-auth body size: `/api/approvals` now reads up to 1 MB before the session gate and rate limiter (the global parser already read up to 256 KB there; this is the brief's design). Worth knowing, not changed.
- `README` mentions `npm run seed:dev -w @roofline/api`, which does not exist until Task 9; the line says so ("Task 9 of the F2 plan"). Task 9 may want to reword that parenthetical.
- `README` "Map tiles" bullet restates the global constraint (`VITE_MAPTILER_KEY`, `VITE_MAP_TILES=osm`, blank style otherwise); the map code is another task.
- The F1 flake (`rep-visibility.test.ts:400`) did not show up in the final run.
- Nothing outside the brief's file list was touched (plus `approvals-edit.test.ts`, one line, forced by the new field).

## Team review finalization (commit 83a6b46)
- Package apps/api: app.ts (approvals body limit applied only after the session gate; signed-out gets default small limit and 401 first) and test/approvals-approve.test.ts (+14 lines).
- Review 1: 2 findings; contact check: F1 amended, F2 amended (both fixed in 83a6b46). Review 2: 0 findings.
- Verify: npm run typecheck and npm run lint passed clean.
- CI run 38178972637: Platform job success; v1 (node:test) job failed, the known pre-existing empty v1 data file on older task branches (not this task's). ci-check's script printed a shell parse error at line 47 while watching, so the result was confirmed via gh.
