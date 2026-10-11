minor [13,15]: T13's markTodaySeen fixture works out 'today' with a hardcoded 'America/Chicago' in SQL. The real API path (packages/db/src/system/me.ts markTodayShown, which backs T15's POST /api/me/today-shown) uses the company's timezone column instead. The two agree today only because seedTwoCompanies gives both companies America/Chicago. If the seed's timezone changes, Today would auto-open over the map in every T13 shell spec, and the single-dialog assertions would fail.
 -> Optional hardening in T13: read the timezone from the company row in SQL, e.g. `update memberships m set last_today_shown_on = (now() at time zone c.timezone)::date from companies c where c.id = m.company_id and m.user_id = (select id from users where email = $1)`. This can wait until after the merge.

minor [15]: useTodayAutoOpen only checks the path the person arrived on (firstPath === '/'). It never checks the current path when the POST resolves. If someone lands on '/' and clicks a dock app before /api/me/today-shown answers, navigate('/today') takes them away from the window they just opened. With T13 merged, any future e2e spec that skips markTodaySeen and clicks the dock quickly would hit this.
 -> In onSuccess, navigate only if the current location is still '/' (keep a ref to the latest pathname, or read window.location.pathname). Add a unit test for it in apps/web/test/today.test.tsx.

minor [13,15]: No e2e spec covers T15's auto-open flow (the first visit to '/' opens /today, the second does not). T13 only turns the feature off with markTodaySeen.
 -> After both merge, add (or confirm a later task adds) a shell spec: log in without markTodaySeen, goto('/'), expect a 'My day' dialog and URL /today, press Esc, reload, and expect no dialog.

No textual merge conflicts are expected. The two branches touch completely separate files.
- T13 touches: .github/workflows/ci.yml, apps/web/e2e/{fixtures,shell.spec,stack}.ts, apps/web/package.json, apps/web/playwright.config.ts, apps/web/tsconfig.json, eslint.config.js, package-lock.json, package.json.
- T15 touches: apps/web/src/app/router.tsx, apps/web/src/copy/today.ts, apps/web/src/features/today/*, apps/web/src/shell/Shell.tsx, apps/web/test/helpers.tsx, apps/web/test/today.test.tsx.
- Merge order does not matter. Only T13 changes package-lock.json, so it merges cleanly; run `npm ci` after the merge.

How the two fit together at runtime:
- T15 calls `useTodayAutoOpen()` from Shell. It POSTs /api/me/today-shown, which already exists at the base (apps/api/src/auth/me.ts → packages/db/src/system/me.ts markTodayShown, column memberships.last_today_shown_on). On `show: true` it navigates to /today, but only when the person arrived on '/'.
- T13's shell specs head this off: every test that visits '/' calls `markTodaySeen(email)` first, and that sets last_today_shown_on for the seeded owner. So the assertions that exactly one dialog is open, that it is named after the app, and that Esc goes home hold after T15 lands.
- The deep-link test goes straight to /approvals/:id, which T15 deliberately never auto-opens over. It should be unaffected either way.

Other compatibility checks:
- T15's 'Need your OK' heading is an h3 inside the Today window, which only appears at /today. It does not clash with T13's `getByRole('dialog', { name: 'Need your OK' })` or with the pill link `'1 need your OK'`.
- The 'today' route sits inside AppWindow app="today", which uses WINDOW_COPY.today ('My day'), already present at the base. It is not a dock app, so T13's six-app list stays correct.
- T15 adds 'POST /api/me/today-shown' → {show:false} to SHELL_ROUTES in test/helpers.tsx. Existing unit shell tests that use SHELL_ROUTES keep passing.
- Copy and lint: T15 keeps all user-facing text in copy/today.ts, uses Button/UiLink from @roofline/ui (no raw <button>), and has explicit .ts/.tsx imports. T13's specs match on literal strings in test code, which is fine under the JSX-literal rule because they are not JSX.
- T13 adds 'e2e' to apps/web tsconfig include. After the merge, the typecheck also covers e2e/, which imports @roofline/api and @roofline/db/testing through workspace hoisting. Run `/home/user/roofline/ops/bin/slot npm run typecheck` and `/home/user/roofline/ops/bin/slot npm run lint` on the integration branch.
- .stack.json, test-results and playwright-report are already gitignored.
- The e2e job needs Docker, so let GitHub Actions run it through ci-check. Do not run it locally.
