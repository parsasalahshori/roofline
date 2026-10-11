### Task 13: End-to-end harness and shell tests

**Base:** `f2-shell` after T6, T7, T8 and T9 are merged (the stack needs `WEB_DIST_DIR` + CSP from T6, `WEATHER_DISABLED` from T8, and `startTestDatabase` / `seedShowcase` / `seedDemoTask` from T9). T14 and T16 may or may not be merged; nothing here depends on them (Ruling C).

**Split:**
- Builder 1: `apps/web/e2e/stack.ts` and `apps/web/playwright.config.ts`.
- Builder 2: `apps/web/e2e/fixtures.ts` and `apps/web/e2e/shell.spec.ts`.
- Builder 3: `apps/web/package.json`, root `package.json`, `apps/web/tsconfig.json`, `.github/workflows/ci.yml`, `package-lock.json` (the only builder that runs `npm install`, and only for the four dev dependencies below).

**Files:**
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/stack.ts`, `apps/web/e2e/fixtures.ts`, `apps/web/e2e/shell.spec.ts`
- Modify: `apps/web/package.json`, root `package.json`, `apps/web/tsconfig.json` (`include` gains `"e2e"`), `.github/workflows/ci.yml`, `package-lock.json`
- Not touched: anything under `apps/web/src` unless a spec exposes a real shell defect (then the lead fixes it and lists it in the report).

**Interfaces:**
- **Dependencies (`apps/web` devDependencies):** `@playwright/test` pinned to an exact version whose bundled Chromium is revision **1194** (the browser pre-installed at `/opt/pw-browsers/chromium-1194`; expected `1.56.1` — confirm with `node -p "require('playwright-core/browsers.json').browsers.find(b=>b.name==='chromium').revision"`), `@axe-core/playwright` (current, used by T17), `pg` and `@types/pg` (same majors as `packages/db`). `tsx` is already at the root. Install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`. **Never run `playwright install` locally.**
- **Scripts:**
  - `apps/web`: `"e2e": "npm run build && playwright test"`. The build runs with no `VITE_*` env, so the blank map style is used.
  - root: `"e2e": "npm run e2e -w @roofline/web --"`. The trailing `--` matters: `npm run e2e -- --project desktop` must reach Playwright, not npm.
- **`e2e/stack.ts`** (run by Playwright's `webServer`; stays in the foreground):
  1. `const db = await startTestDatabase()` from `@roofline/db/testing` (urls `{ owner, tenant, system }`).
  2. Write `e2e/.stack.json` = `{ ownerUrl, tenantUrl, systemUrl, baseUrl: 'http://127.0.0.1:4410' }` (already in `.gitignore`).
  3. `await resetScenario(urls)` from `./fixtures.ts`.
  4. Spawn the API: `npx tsx apps/api/src/server.ts` with `cwd` = repo root and env (on top of `process.env`):
     - `NODE_ENV=test`, `PORT=4410`, `HOST=127.0.0.1`
     - `APP_ORIGIN=http://127.0.0.1:4410`, `PUBLIC_BASE_URL=http://127.0.0.1:4410`
     - `DATABASE_URL_TENANT=<tenant>`, `DATABASE_URL_SYSTEM=<system>`
     - `ENCRYPTION_KEY=randomBytes(32).toString('base64')`, `WEATHER_DISABLED=1`
     - `WEB_DIST_DIR=apps/web/dist` (config resolves it from the repo root)
     - `API_RATE_LIMIT_PER_MIN=100000` (the suite reloads a lot from one session)
  5. Spawn the worker: `npx tsx apps/worker/src/index.ts`, same env.
  6. Pipe each child's stdout/stderr line by line with a `[api] ` / `[worker] ` prefix.
  7. On SIGINT/SIGTERM: kill both children, `await db.stop()`, exit 0. If either child exits on its own, stop the db and exit 1 (so Playwright fails fast instead of waiting 300 s).
- **`e2e/fixtures.ts`:**
  - `readStack(): { ownerUrl; tenantUrl; systemUrl; baseUrl }` reads `.stack.json`.
  - `resetScenario(urls: { owner: string; tenant: string; system: string }): Promise<Scenario>`:
    `resetDb(urls.owner)` → `const { a } = await seedTwoCompanies(urls.owner)` → `const { taskId } = await seedShowcase(pools, a.companyId, new Date(), { companyName: 'Acme Roofing' })`. `pools = createPools({ tenant, system })` from `@roofline/db`, created once per process and reused. `seedShowcase` and `seedDemoTask` come from `@roofline/api`.
  - `type Scenario = { a: SeededCompany; taskId: string }`
  - `test = base.extend<…>` with:
    - `scenario` (`{ auto: true }`, per test): calls `resetScenario` first.
    - `loginAs(page, who: 'owner' | 'office' | 'rep')`: `page.request.post('/api/auth/login', { data: { email, password: SEED_PASSWORD }, headers: { Origin: baseUrl } })`, expects 200. Emails are `owner@a.test`, `office@a.test`, `rep@a.test` (`scenario.a.owner.email` etc.).
    - `db`: a connected `pg.Client` on `ownerUrl`, ended after the test.
    - `pools`: the shared pools (for `seedDemoTask(pools, 'acme-roofing', new Date())`).
    - `clicks`: `{ count: number }`; `click(locator)` helper that increments it then `locator.click()`.
    - `markTodaySeen(email)`: `update memberships set last_today_shown_on = (now() at time zone 'America/Chicago')::date where user_id = (select id from users where email = $1)`.
  - Export `expect` from `@playwright/test` alongside.
- **`playwright.config.ts`:**
  - `testDir: 'e2e'`, `workers: 1`, `fullyParallel: false`, `forbidOnly: !!process.env.CI`, `retries: 0`, `reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list'`
  - `use: { baseURL: 'http://127.0.0.1:4410', trace: 'retain-on-failure', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined } }` — the swiftshader flags give headless Chromium WebGL so MapLibre loads and the pins summary renders. Locally `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` is already set; if the pinned version does not match revision 1194, run with `PW_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium` (symlink to `chromium-1194/chrome-linux/chrome`).
  - `webServer: { command: 'npx tsx e2e/stack.ts', url: 'http://127.0.0.1:4410/health', timeout: 300_000, reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe' }`
  - projects: `desktop` = `{ ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }`, `testIgnore: /phone\.spec/`; `phone` = `{ ...devices['Pixel 7'], viewport: { width: 375, height: 812 } }`, `testMatch: /phone\.spec/` (no phone spec until T17; that is fine).

**Tests (`shell.spec.ts`)** — every test does `await loginAs(page, 'owner'); await markTodaySeen('owner@a.test');` first. Find banners and summaries by text, never a bare `role=status` (several are always mounted).
- `test('map home shows the seeded pins')`: `goto('/')` → `await expect(page.getByText('Map showing 70 customers and 25 open jobs.')).toBeAttached({ timeout: 20_000 })` (70 addresses; 25 = lead 8 + inspection 7 + proposal 6 + won 4).
- `test('dock has six labeled apps that each open one window with its own URL')`: for each of `Storm /storm`, `Front Desk /front-desk`, `Estimator /estimator`, `Jobs /jobs`, `Calendar /calendar`, `Agents /agents`: `goto('/')`, click `page.getByRole('navigation', { name: 'Apps' }).getByRole('link', { name: <label> })` → `toHaveURL(new RegExp(path + '$'))`; `getByRole('dialog')` has count 1 and `toHaveAccessibleName(<label>)`; its `boundingBox()` satisfies `Math.abs(box.x - (1440 - box.x - box.width)) <= 2`, `box.width <= 1280`, `box.height <= 860`. (Use the dock link's accessible name as rendered — if it includes the "Coming soon" note, match with `{ name: label, exact: false }`.)
- `test('Esc and ✕ go home, Back goes to the previous window')`: open Storm then Jobs via the dock; `page.goBack()` → `/storm` with the dialog named "Storm"; `keyboard.press('Escape')` → URL `/`, no dialog; open Jobs; click `getByRole('button', { name: 'Close' })` → `/`.
- `test('deep link opens the review directly')` (**Ruling C**): `goto('/approvals/' + scenario.taskId)` → `toHaveURL('/approvals/' + taskId)` and `getByRole('dialog', { name: 'Need your OK' })` is visible. Nothing else — T18 extends it.
- `test('focus stays inside the window')`: open Jobs; 15× `keyboard.press('Tab')`, each followed by `expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)`.
- `test('pill shows the live draft count')`: `goto('/')` → link `1 need your OK` visible; `await seedDemoTask(pools, 'acme-roofing', new Date())`; `page.reload()` → link `2 need your OK`.

**CI (`.github/workflows/ci.yml`):** add a third job; keep `platform` and `v1` unchanged.
```yaml
  e2e:
    name: E2E (Playwright)
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      # CI has no pre-installed browser: fetch the pinned version's Chromium and its system libraries.
      - run: npx playwright install --with-deps chromium
        working-directory: apps/web
      # The stack starts PostGIS with Testcontainers on the runner's Docker (amd64, native).
      - run: npm run e2e -- --project desktop
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: |
            apps/web/playwright-report
            apps/web/test-results
          retention-days: 7
```
T17 later widens the run to both projects.

**Verify notes:**
- There is no Docker daemon in the cloud box, so the stack cannot start locally; **the specs are proven on CI only.** Locally run: `npm run typecheck && npm run lint && npx playwright test --list -c apps/web/playwright.config.ts` (`--list` does not start the webServer; it must list 6 desktop tests and 0 errors). Do not run `npm run e2e`.
- After `ci-check` reports the Platform job, the lead must also read the **E2E** job's conclusion for the same run (ci-check judges only Platform; see the controller note) and paste its tail into the report.
- Commit: `test(e2e): self-contained stack and shell tests`.
