### Task 21: Trial end, read-only mode, and the company status on the session

**Base:** `f3-setup` after Task 9 is merged. From T9: stubs `apps/api/src/billing/read-only.ts` (`readOnlyGuard: RequestHandler`, already mounted as `app.use('/api', readOnlyGuard)` right after `attachSession … requireSession`) and `apps/api/src/jobs/scheduler/end-trials.ts` (`endTrials(deps, now)`, in `SCHEDULES` as `end-trials` `*/5 * * * *`). From T1: placeholder `packages/db/src/system/trials.ts` (in the system barrel). Existing: `findLiveSession` + `SessionRecord` in `packages/db/src/system/auth.ts`; `SessionInfo`, `resolveSessionDetailed` in `apps/api/src/auth/sessions.ts`; `dispatchDueMessages` in `jobs/scheduler/dispatch-messages.ts`.
**Parallel hazard:** T15 edits `auth/routes.ts` and `auth/middleware.ts` at the same time — this task must not touch either.

**Split:**
- Builder 1: `packages/db/src/system/auth.ts` (`findLiveSession` joins `companies`) and `apps/api/src/auth/sessions.ts` (`companyStatus`).
- Builder 2: `packages/db/src/system/trials.ts` and `apps/api/src/jobs/scheduler/end-trials.ts`.
- Builder 3: `apps/api/src/billing/read-only.ts` and the tests.

**Files:**
- Modify: `packages/db/src/system/auth.ts` (`SessionRecord`, `findLiveSession` only), `packages/db/src/system/trials.ts`, `apps/api/src/auth/sessions.ts` (`SessionInfo` only), `apps/api/src/billing/read-only.ts`, `apps/api/src/jobs/scheduler/end-trials.ts`
- Test: `apps/api/test/read-only.test.ts`, `apps/api/test/end-trials.test.ts`
- Do not touch: `auth/routes.ts`, `auth/middleware.ts`, `app.ts`, `jobs/worker.ts`.

**Interfaces:**
```ts
// SessionRecord (system/auth.ts) and SessionInfo (auth/sessions.ts) gain: companyStatus: CompanyStatus
// findLiveSession adds `.innerJoin(companies, eq(companies.id, memberships.companyId))` and selects companies.status as companyStatus
// system/trials.ts
export async function endExpiredTrials(system: Db, now: Date): Promise<string[]>;   // update companies set status='trial_ended', updated_at=now where status='trial' and trial_ends_at <= now returning id
// jobs/scheduler/end-trials.ts
export async function endTrials(deps: AppDeps, now: Date): Promise<void>;           // endExpiredTrials, then per id an audit 'billing.trial_ended' through withTenant(systemContext(id))
// billing/read-only.ts
export const READ_ONLY_MESSAGE: Record<'trial_ended' | 'canceled', string>;
export const readOnlyGuard: RequestHandler;
```
- **`READ_ONLY_MESSAGE`:**
  - `trial_ended`: "Your free trial has ended, so Roofline is read-only for now. Pick a plan to keep going."
  - `canceled`: "Your plan was canceled, so Roofline is read-only for now. Pick a plan to keep going."
- **`readOnlyGuard`:** reads `req.session as SessionInfo | undefined`; when there is a session, its `companyStatus` is `trial_ended` or `canceled`, the method is not GET/HEAD/OPTIONS, and `req.path` (relative to `/api`, lowercased) does not start with `/auth/`, `/billing/` or `/me/` → 403 `{ error: READ_ONLY_MESSAGE[status] }`. Otherwise `next()`. No session (public auth routes) → `next()`.
- **`past_due` is not read-only** (Ruling 8): the gate's `billing` rule pauses texts.
- Status is read on every request with the session (the join), so a change applies on the next request without signing in again. Every place that builds a `SessionInfo` literal (grep `SessionInfo`, `emailVerified:` in `apps/api/src` and `apps/api/test`) must add `companyStatus`.

**Tests:**
- `end-trials.test.ts`: a `trial` company with `trial_ends_at` = now − 1 minute → `trial_ended` plus one `billing.trial_ended` audit row; a trial with time left, and an `active` company, are untouched; a second run changes nothing.
- `read-only.test.ts` (set `companies.status` by owner SQL):
  - `test('reads work, writes are refused with the plain message')`: `trial_ended` → `GET /api/customers` 200; `POST /api/customers`, `PATCH /api/company` and `POST /api/approvals/<id>/approve` → 403 with exactly the trial message.
  - `test('signing out, billing and today-shown still work')`: `POST /api/auth/logout` → 200; `POST /api/billing/checkout` → status is not 403 with the read-only message (T19 may not be merged: 404 is fine); `POST /api/me/today-shown` → 200.
  - `test('canceled has its own message')`.
  - `test('the next request sees a status change without signing in again')`: same agent; `POST /api/customers` 201 → set `trial_ended` → 403 → set `active` → 201.
  - `test('past due is not read-only')`: `POST /api/customers` → 201.
  - `test('the dispatcher blocks a scheduled text once the trial ended')`: a text `scheduled` for later (quiet hours; use `./sms-helpers.ts` `BATCH_AT`/`NEXT_MORNING_NY` and `approvedBatch`), then set `trial_ended`, advance the clock, `dispatchDueMessages(t.deps, now)` → the row is `blocked` with `block_rule 'billing'`.

**Verify notes:**
- api/db suites need Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(billing): end trials on time; read-only mode after a trial or a cancel`.
