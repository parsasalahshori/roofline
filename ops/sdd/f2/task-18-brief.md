### Task 18: The deferred Playwright specs (approvals, Today, the deep-link extension, phone, accessibility) and the F2 acceptance map

**Why:** Ruling P built T14 and T15 without their end-to-end specs, and the controller's T17 scope cut (Ruling AK) left out `phone.spec.ts`, `a11y.spec.ts`, the CI phone run and the F2 acceptance map; this task writes them all on T13's stack. F3 Task 36 later extends `phone.spec.ts` and `a11y.spec.ts`, so keep them easy to append to (one `test` per page group, shared helpers at the top). Ruling C: T13's deep-link test asserts only the URL and the "Need your OK" dialog; this task adds the rest.
**Base:** `f2-shell` after T13, T14, T15 and T17 are merged (T6 is in). T13's actual config (`apps/web/playwright.config.ts` on `f2-t13`): projects `desktop` (`Desktop Chrome`, 1440×900, `testIgnore: /phone\.spec/`) and `phone` (`Pixel 7`, 375×812, `testMatch: /phone\.spec/`); swiftshader launch args; `PW_CHROMIUM_EXECUTABLE` override; `@axe-core/playwright` ^4.13 and `@playwright/test` 1.56.1 already in `apps/web/package.json` (install nothing). T13's CI job runs `npm run e2e -- --project desktop`. No `apps/web/src` changes are expected; if a spec exposes a real defect, the lead fixes it and lists it in the report.

**Split:**
- Builder 1: `apps/web/e2e/approvals.spec.ts`.
- Builder 2: `apps/web/e2e/today.spec.ts` and `apps/web/e2e/a11y.spec.ts`.
- Builder 3: the deep-link test in `apps/web/e2e/shell.spec.ts` (that one test only), `apps/web/e2e/phone.spec.ts`, the CI change in `.github/workflows/ci.yml`, and `ops/sdd/f2/f2-acceptance.md`.

**Files:**
- Create: `apps/web/e2e/approvals.spec.ts`, `apps/web/e2e/today.spec.ts`, `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts`, `ops/sdd/f2/f2-acceptance.md`
- Modify: `apps/web/e2e/shell.spec.ts` (`test('deep link opens the review directly')` only), `.github/workflows/ci.yml` (the E2E job's run line only)
- Reads, does not change: `apps/web/e2e/fixtures.ts` (T13: `test`, `expect`, `scenario`, `loginAs`, `db`, `pools`, `clicks` + `click`, `markTodaySeen`). If a helper is missing, add it to `fixtures.ts` in Builder 1's package and say so.

**What the screens say** (from `f2-t14` and `f2-t15`; match these exactly):
- Pill: `1 need your OK` (`copy/shell.ts` `needYourOk`). Storm window button-link: `Approve storm plan` (`copy/storm.ts`).
- Review window title: `Need your OK` under `/approvals/:id`, `Storm` under `/storm/plans/:id`. Plan title: `Storm plan: hail on the north side`. Steps (`demoTask`): `Text 31 customers` (message), `Door-knock routes for 4 reps` (internal), `Google + Facebook ads on the swath` (spend, max $270).
- Approve button (`copy/review.ts` `approveButton`): `Approve 3 steps · up to $270`, `Approve 2 steps · up to $270`, `Approve 2 steps · send ad to owner`, `Approve 1 step · up to $270`.
- Step switches are `role="switch"` named by the step title. Step rows are `li` elements with `data-status`; status words come from `STEP_STATUS_LABEL`: `Done`, `Turned off`, `Waiting for owner`. Spend row note for a non-delegated office user: `Your owner approves spending`.
- Today: dialog `My day`; heading starts `Good`.
- **Phone shell (T17, `origin/f2-shell` `apps/web/src/shell/phone/*`):** below 768px (`useIsPhone`, `(max-width: 767.98px)`) there is no dock; `BottomTabs` is `getByRole('navigation', { name: 'Main' })` with links `My day` → `/today`, `Map` → `/`, `Jobs` → `/jobs`, `Calendar` → `/calendar` (each `aria-current="page"` when current) and a `More` button (`aria-haspopup="dialog"`) that opens the `MoreSheet`, a dialog named `More` listing links `Storm`, `Front Desk`, `Estimator`, `Agents`, `Settings` (choosing one closes it). Windows render `data-variant="page"` between `--shell-top-inset` (57px on phone) and `--shell-bottom-inset` (`48px` tabs + safe area). The review's Approve footer is pinned (T5's sticky footer inside the page window).
- Count step statuses inside the step list (`getByRole('dialog').getByRole('list')`), never the whole dialog: the stat strip shows the task status (`Done` too) once all steps finish.
- Locate a row with `page.getByRole('dialog').getByRole('listitem').filter({ hasText: '<step title>' })`.

**Tests:**
- **`approvals.spec.ts`** (desktop project; each test starts `await loginAs(page, who); await markTodaySeen('<who>@a.test');`):
  - `test('one draft: pill to approved in 2 clicks')`:
```ts
await loginAs(page, 'owner'); await markTodaySeen('owner@a.test'); await page.goto('/');
await click(page.getByRole('link', { name: '1 need your OK' }));
await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
// Scoped to the step list: once every step is done the task's own status in the stat strip also reads "Done".
await expect(page.getByRole('dialog').getByRole('list').getByText('Done', { exact: true })).toHaveCount(3, { timeout: 15_000 });
expect(clicks.count).toBe(2);
```
  - `test('from the Storm window: 2 clicks')`: `goto('/storm')`; `click(link 'Approve storm plan')` → URL `/storm/plans/<taskId>`; `click(button 'Approve 3 steps · up to $270')` → 3 × `Done` (15 s); `clicks.count === 2`.
  - `test('turning a step off excludes it')`: `goto('/approvals/' + scenario.taskId)`; click `getByRole('switch', { name: 'Door-knock routes for 4 reps' })` → `toHaveAttribute('aria-checked', 'false')`; button reads `Approve 2 steps · up to $270`; click it → the door-knock row contains `Turned off`, the other two rows contain `Done` (15 s).
  - `test('office approves two, the ad waits for the owner')`:
    - `loginAs(page, 'office')`, `markTodaySeen('office@a.test')`, `goto('/approvals/' + taskId)`.
    - The spend row contains `Your owner approves spending`; the button is `Approve 2 steps · send ad to owner`; click it.
    - Without reloading: the message and door-knock rows contain `Done` (15 s) and the spend row contains `Waiting for owner`.
    - `loginAs(page, 'owner')`, `markTodaySeen('owner@a.test')`, `goto('/')` → click `1 need your OK` → the button is `Approve 1 step · up to $270`.
- **`today.spec.ts`** (desktop; **no** `markTodaySeen`):
  - `test('opens once per day, again the next day')`:
    - `loginAs(page, 'owner')`; `goto('/')` → `toHaveURL(/\/today$/)`, `getByRole('dialog', { name: 'My day' })` contains `Good`; `keyboard.press('Escape')` → `/`.
    - `goto('/')` → after `page.waitForResponse('**/api/me/today-shown')`, URL is still `/` and `getByRole('dialog')` has count 0.
    - `db.query("update memberships set last_today_shown_on = last_today_shown_on - 1 where user_id = (select id from users where email = $1)", ['owner@a.test'])`.
    - `goto('/')` → `/today`.
  - `test('a deep link does not open Today')`: `loginAs(page, 'owner')`; `goto('/jobs')` → dialog `Jobs`, URL stays `/jobs` (wait 1 s, or assert no `today-shown` request was made via `page.on('request')`); then `goto('/')` → `/today` (it had not been shown yet that day).
- **`shell.spec.ts` deep-link test** (replaces T13's body; this test does **not** call `markTodaySeen`, so Today would be due):
  - `goto('/approvals/' + scenario.taskId)` → URL unchanged; `getByRole('dialog', { name: 'Need your OK' })` visible and contains `Storm plan: hail on the north side`; `getByRole('button', { name: 'Approve 3 steps · up to $270' })` visible; `getByRole('dialog', { name: 'My day' })` has count 0 and `page.url()` does not end with `/today`.

- **`phone.spec.ts`** (phone project; each test `loginAs(page, 'owner')` + `markTodaySeen('owner@a.test')`; helper `noSideScroll(page)` = `expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375)`; T36 appends F3 pages to the same list):
  - `test('bottom tabs work')`: from `/`, tap `Map` → `/`; `My day` → `/today` with the dialog `My day`; `Jobs` → `/jobs`; `Calendar` → `/calendar`; each tapped link has `aria-current="page"`; `More` → dialog `More` → `Storm` → `/storm` and the sheet is gone. No dock (`getByRole('navigation', { name: 'Apps' })` count 0).
  - `test('no horizontal scroll')`: for `/`, `/approvals`, `'/approvals/' + scenario.taskId` → `noSideScroll`.
  - `test('Approve stays pinned')`: on `/approvals/<taskId>`, `const tabs = await page.getByRole('navigation', { name: 'Main' }).boundingBox()`; the button `Approve 3 steps · up to $270` box satisfies `box.y + box.height <= tabs.y` (i.e. ≤ 812 − tabs height); `page.mouse.move(187, 400); page.mouse.wheel(0, 2000)` → still true.
  - `test('long text does not widen the page')`: SQL via `db`: `update customers set display_name = repeat('Long', 15) where company_id = $1` (60 characters) and `update agent_task_steps set payload = jsonb_set(payload, '{sample}', to_jsonb(repeat('word ', 80))) where task_id = $2 and type = 'demo_message'` (400 characters); open the review → `noSideScroll`.
- **`a11y.spec.ts`** (desktop; owner, `markTodaySeen`): `import AxeBuilder from '@axe-core/playwright'`; helper `scan(page)` = `new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()` and fail on any violation with `impact` `serious` or `critical` (print `id` and target selectors in the message). Tests: the map home `/` (wait for the map summary text first), `/approvals`, `/approvals/<taskId>`. Exclusion: only `.maplibregl-ctrl-attrib`, and only if MapLibre's own attribution control fails contrast — add `.exclude('.maplibregl-ctrl-attrib')` with a comment giving the axe rule id that forced it; otherwise no exclusions. T36 adds `/sign-up` and `/settings/setup` as new tests in this file.
- **CI (`.github/workflows/ci.yml`):** the E2E job's run line becomes `npm run e2e -- --project desktop --project phone` (one build, both projects). Keep the failure artifact upload as is.
- **`ops/sdd/f2/f2-acceptance.md`:** in the format of `docs/superpowers/f1-acceptance.md` (a header with the branch, date and the commands; then the list): every bullet of spec §4.8 (`docs/superpowers/specs/2026-10-10-roofline-foundation-design.md`) mapped to its test(s) as `file` — `test name`: Shell (map pins, six dock apps, pill count, one centered window per URL, Esc/✕/Back/deep link, focus trap → `shell.spec.ts` + the unit `shell.test.tsx`), Today once per day (`today.spec.ts` + `today.test.tsx`), R2 review (the 2-click test, turning a step off, office + "Waiting for owner", live results → `approvals.spec.ts`; unit `review.test.tsx`), Phone (`phone.spec.ts`, `phone.test.tsx`), UI tests (the stylelint 12px rule test in `packages/ui/test`, `copy-rules.test.ts`, `a11y.spec.ts`). Read the test names from the files; leave a line "Not yet green on CI" for anything whose CI run has not passed when the report is written.

**Verify notes:**
- No Docker locally: these run on CI only, in the E2E job (now both projects). Locally: `npm run typecheck && npm run lint && npx playwright test --list -c apps/web/playwright.config.ts` (must list the new desktop and phone tests with no errors). Never `playwright install`; never `npm run e2e` here.
- After `ci-check`, read the E2E job's conclusion for the run and paste its tail into the report.
- Commit: `test(e2e): approvals, Today, phone and accessibility specs; F2 acceptance map`.
