### Task 14: Web: approvals list and the review screen

**Files:**
- Create: `apps/web/src/features/approvals/{ApprovalsList,Review,EditStepSheet,NotNowSheet}.tsx`, `apps/web/src/features/approvals/{toReviewStep,editable}.ts`, `apps/web/src/copy/{approvals,review}.ts`, `apps/web/e2e/approvals.spec.ts`
- Modify: `apps/web/src/app/router.tsx` (the approvals routes, `storm/plans/:taskId`), `apps/web/src/api/hooks.ts` (`useTask`, `useEditStep`, `useApprove`, `useDecline`, `useRetryStep`, `useRerun`), `apps/web/e2e/shell.spec.ts` (finish the deep-link test)
- Test: `apps/web/test/to-review-step.test.ts`, `apps/web/test/review.test.tsx`, `apps/web/test/review-copy.test.ts`

**Interfaces:**
- **`toReviewStep(step: StepView, task: TaskView): ReviewStep`:**
  - `open`: the caller has a decision on this step. That is `status === 'pending'` while the task is `draft`, or `status === 'awaiting_owner'` while the task is `awaiting_owner`. Confirm these against the open-step rule in `approveTask` (`apps/api/src/tasks/service.ts:476`); if the API differs, follow it.
  - `title`: `step.preview.title`.
  - `editable`: `editableText(step) !== null`.
- **`editableText(step: StepView): { key: 'sample' | 'body'; value: string } | null`:**
  - `demo_message` → `payload.sample`
  - `send_sms_batch` → `payload.body`
  - anything else → null
- **Review mode:** `'review'` when the task is not expired, its status is `draft` or `awaiting_owner`, and some step is `open`. Otherwise `'progress'`.
- **Review copy (`copy/review.ts`):**
  - `approveButton(s)`:
    - `ownerSteps > 0 && count > 0` → `Approve ${count} ${step(s)} · send ${ownerSteps === 1 ? 'ad' : ownerSteps + ' steps'} to owner`
    - `ownerSteps > 0 && count === 0` → `Send to owner`
    - `maxSpendCents > 0` → `Approve ${count} ${step(s)} · up to ${dollars}`
    - otherwise `Approve ${count} ${step(s)}`
    - `step(s)` is "step" when 1, else "steps"; `dollars` is a whole-dollar `Intl.NumberFormat('en-US', {style:'currency', currency:'USD', maximumFractionDigits: 0})`
  - `nothingOn`: "Turn on a step to approve"
  - `notNow`: "Not now"
  - `footerNoteSpend`: "Ad spend comes from your connected ad accounts."
  - `footerNote`: "Nothing goes out until you approve."
  - `ownerApprovesSpending`: "Your owner approves spending"
  - `waitingForOwner`: "Waiting for owner"
  - `recipients(n)`: `${n} customers`
  - `sendTime(t)`: `Sends ${t} · quiet hours respected`
  - `spend(c)`: `Up to ${dollars}`
  - `resultLines(r)`: each numeric key mapped through a plain map (sent → "sent", delivered → "delivered", failed → "couldn't send", blocked → "held back", replies → "replies", booked → "inspections booked"; unknown keys skipped) as `${n} ${word}`
  - `stepStatus`: `stepStatusLabel`
- **`Review({ taskId })`:**
  - Loads with `useTask`.
  - Refetches every 2 s while any step is `queued` or `running`, or for 10 s after an approve. Otherwise it does not poll.
  - **Toggle** → `PATCH /api/approvals/:taskId/steps/:stepId {version, enabled}`, optimistic, with the step id in `pendingStepIds` until it settles.
  - **Edit** → `EditStepSheet`: a multiline `Field` holding the text. Save → `PATCH {version, payload: {...payload, [key]: text}}`. A 400 shows the error on the field.
  - **Approve** → `POST /approve {steps: open steps' {id, version}}`.
    - The button is `busy` while pending, and a second click is ignored (mutation `isPending` guard).
    - On success the view switches to progress in the same window.
  - **Not now** → `NotNowSheet` with an optional reason (≤ 500) and a confirm "Not now". It POSTs decline, then toasts `copy.approvals.declined` and navigates to `/approvals` when more drafts remain, else to `/`.
  - **Any 409:** set the cached task to `error.latest` (when it is a TaskView; a step 409 carries a StepView, so refetch the task) and toast the API message.
  - **Retry** → POST retry.
  - **Expired task:** an `EmptyState` "This plan expired" with a primary "Run it again" → POST rerun → navigate to the new task's URL (under the same window: `/approvals/` or `/storm/plans/`).
  - **404:** the Not found empty state.
  - **Window stat strip:** the task's agent label, then `taskStatusLabel(task)`, then the time it was created.
- **`ApprovalsList`:**
  - `GET /api/approvals` tasks, newest first. Each is a `Card` link → `/approvals/:id`, showing the agent label, title, summary (two lines, ellipsis) and status label. Expired drafts show "Expired".
  - Empty → `EmptyState` "Nothing needs your OK."
  - For a rep → `EmptyState` "Approvals are for owners and office staff."

- [ ] **Step 1: Write the failing tests**
  - `review-copy.test.ts`:
```ts
expect(approveButton({ count: 3, maxSpendCents: 27000, ownerSteps: 0 })).toBe('Approve 3 steps · up to $270');
expect(approveButton({ count: 2, maxSpendCents: 0, ownerSteps: 1 })).toBe('Approve 2 steps · send ad to owner');
expect(approveButton({ count: 1, maxSpendCents: 0, ownerSteps: 0 })).toBe('Approve 1 step');
expect(approveButton({ count: 0, maxSpendCents: 0, ownerSteps: 1 })).toBe('Send to owner');
```
  - `to-review-step.test.ts`: the open rule for draft, awaiting_owner and done tasks; `editable` for demo_message with and without `sample`.
  - `review.test.tsx` (stubbed fetch):
    - `it('turning a step off leaves it out')`: PATCH sent with `enabled:false`; the button reads "Approve 2 steps"; the approve body lists all 3 steps' ids and versions.
    - `it('a 409 reloads the latest and says so')`: approve → 409 with `latest` (one step now disabled) → the toast text is the API message and the view shows the latest.
    - `it('a double click approves once')`.
    - `it('Not now declines with a reason')`.
    - `it('an expired plan offers Run it again')` → POST rerun → navigate to `/approvals/new-id`.
    - `it('a rep sees the owners-only empty state')`.
  - `approvals.spec.ts` (e2e):
    - `test('one draft: pill to approved in 2 clicks')`:
```ts
await loginAs(page, 'owner'); await markTodaySeen('owner@a.test'); await page.goto('/');
await click(page.getByRole('link', { name: '1 need your OK' }));
await click(page.getByRole('button', { name: 'Approve 3 steps · up to $270' }));
await expect(page.getByRole('dialog').getByText('Done')).toHaveCount(3, { timeout: 15_000 });
expect(clicks.count).toBe(2);
```
    - `test('from the Storm window: 2 clicks')`: `goto('/storm')`, click "Approve storm plan", click "Approve 3 steps · up to $270" → 3 × Done; `clicks.count === 2`.
    - `test('turning a step off excludes it')`: switch off "Door-knock routes for 4 reps" → "Approve 2 steps · up to $270" → after approve, that row shows "Turned off" and the other two "Done".
    - `test('office approves two, the ad waits for the owner')`: the office logs in, opens the plan; the spend row shows "Your owner approves spending"; the button is "Approve 2 steps · send ad to owner"; click → two rows "Done" (live, no reload) and the spend row "Waiting for owner". Then the owner logs in → "1 need your OK" → opens it → the button is "Approve 1 step · up to $270".
    - `shell.spec.ts` deep-link test: now also asserts the Approve button is visible and the Today window did not open.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the unit and e2e suites** — `npx vitest run --project @roofline/web && npm run e2e -- --project desktop`. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): approvals list and the review screen with live results`

---

