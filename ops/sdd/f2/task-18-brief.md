### Task 18: The deferred Playwright specs (approvals, Today, the deep-link extension)

**Why:** Ruling P built T14 and T15 without their end-to-end specs; this task writes them on T13's stack. Ruling C: T13's deep-link test asserts only the URL and the "Need your OK" dialog; this task adds the rest.
**Base:** `f2-shell` after T13, T14 and T15 are merged (and T6 for `/api/me/today-shown`). No `apps/web/src` changes are expected; if a spec exposes a real defect, the lead fixes it and lists it in the report.

**Split:**
- Builder 1: `apps/web/e2e/approvals.spec.ts`.
- Builder 2: `apps/web/e2e/today.spec.ts`.
- Builder 3: the deep-link test in `apps/web/e2e/shell.spec.ts` (that one test only).

**Files:**
- Create: `apps/web/e2e/approvals.spec.ts`, `apps/web/e2e/today.spec.ts`
- Modify: `apps/web/e2e/shell.spec.ts` (`test('deep link opens the review directly')` only)
- Reads, does not change: `apps/web/e2e/fixtures.ts` (T13: `test`, `expect`, `scenario`, `loginAs`, `db`, `pools`, `clicks` + `click`, `markTodaySeen`). If a helper is missing, add it to `fixtures.ts` in Builder 1's package and say so.

**What the screens say** (from `f2-t14` and `f2-t15`; match these exactly):
- Pill: `1 need your OK` (`copy/shell.ts` `needYourOk`). Storm window button-link: `Approve storm plan` (`copy/storm.ts`).
- Review window title: `Need your OK` under `/approvals/:id`, `Storm` under `/storm/plans/:id`. Plan title: `Storm plan: hail on the north side`. Steps (`demoTask`): `Text 31 customers` (message), `Door-knock routes for 4 reps` (internal), `Google + Facebook ads on the swath` (spend, max $270).
- Approve button (`copy/review.ts` `approveButton`): `Approve 3 steps · up to $270`, `Approve 2 steps · up to $270`, `Approve 2 steps · send ad to owner`, `Approve 1 step · up to $270`.
- Step switches are `role="switch"` named by the step title. Step rows are `li` elements with `data-status`; status words come from `STEP_STATUS_LABEL`: `Done`, `Turned off`, `Waiting for owner`. Spend row note for a non-delegated office user: `Your owner approves spending`.
- Today: dialog `My day`; heading starts `Good`.
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

**Verify notes:**
- No Docker locally: these run on CI only, in the E2E job T13 added (`npm run e2e -- --project desktop`). Locally: `npm run typecheck && npm run lint && npx playwright test --list -c apps/web/playwright.config.ts` (must list the new tests with no errors). Never `playwright install`; never `npm run e2e` here.
- After `ci-check`, read the E2E job's conclusion for the run and paste its tail into the report.
- Commit: `test(e2e): approvals, Today and the deep-link review`.
