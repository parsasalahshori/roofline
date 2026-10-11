# F1 acceptance checklist (spec section 3.7)

Run on branch `f1-platform-core`, 2026-10-11:

```
npm run lint && npm run typecheck && npx vitest run && (cd v1 && npm test)
```

- **lint:** clean. **typecheck:** clean (`tsc -b`).
- **Vitest:** 40 files, 2027 tests, all pass (about 30 minutes locally; the PostGIS image runs under emulation on Apple Silicon).
- **v1:** 28 tests, all pass (`node:test`).
- CI (`.github/workflows/ci.yml`) runs the same on push and pull request; the v1 suite is its own job.

Paths are under `apps/api/test/` (API), `packages/<name>/test/` and `v1/tests/`.

## Cross-tenant isolation
- **No cross-company reads or writes through any route**
  - `apps/api/test/isolation.test.ts`: B's owner sends A's ids to every CRM route (404, A's data unchanged); lists never leak; cross-links refused; every approval route; a test that the approval table covers every route.
  - `apps/api/test/team.test.ts`, `approvals-edit.test.ts` ("the tables are tenant-scoped").
- **Raw SQL as `app_tenant`: zero rows with the setting absent, empty or another company's; mismatched writes rejected**
  - `packages/db/test/rls.test.ts`: "app_tenant isolation", roles, grants, RLS and FORCE definitions.
  - `apps/api/test/isolation.test.ts`: "the database agrees".
- **Webhook routing reaches the right company, only that company**
  - `packages/db/test/routing.test.ts` (number to company, per-company signing token, event claims).
  - `apps/api/test/twilio-hooks.test.ts` (A's message lands in A only; "B's number is B's"; status callbacks keyed per company).
- **Scheduler fan-out**
  - `apps/api/test/scheduler.test.ts` (expiry and sweeper reach each company once, under its own id; "system queries read only what app_system may see").
  - `apps/api/test/dispatcher.test.ts` (one company failing does not stop the others; ids only).
  - `packages/db/test/rls.test.ts` ("app_system" column grants).

## Accounts and roles
- **Sign up and sign in by password:** `auth-password.test.ts`
- **Google sign-in, stubbed OIDC:** `auth-google.test.ts` (fake verifier through every branch; the real verifier against a local key server)
- **Email verification and reset:** `auth-email.test.ts`
- **Invite an office user and a rep, change roles:** `team.test.ts` (invites; accept-invite as a new person, with Google, and as an existing user; `PATCH /api/team/members/:id`)
- **Permission matrix, one test per row (spec 3.2)**

| Row | Tests |
|---|---|
| Billing, plan, payment method | `permissions.test.ts` (`can()`; no route until F3) |
| Settings, team, connections | `permissions.test.ts`; `team.test.ts` "who may do what" |
| Approve spend | `permissions.test.ts`; `approvals-approve.test.ts` (office 403, delegated 200); `approvals-edit.test.ts`; `runner.test.ts` (retry) |
| Approve message / internal | `permissions.test.ts`; `approvals-approve.test.ts` (partial approval) |
| Jobs: view, create, edit | `rep-visibility.test.ts`; `jobs.test.ts` |
| Customers and properties | `rep-visibility.test.ts`; `customers.test.ts`; `properties.test.ts` |
| CSV import, consent confirmation | `permissions.test.ts` (`can()`; no route until F3) |
| Company money totals | `permissions.test.ts`; `rep-visibility.test.ts` ("what a rep sees of the money") |

## Approval queue (`demo_noop`, `demo_message`, `demo_spend`)
- **Draft, edit, approve, run, done:** `approvals-edit.test.ts` (create, list, detail, PATCH step); `approvals-approve.test.ts` ("the owner approves the 3 demo steps"); `runner.test.ts`; `pgboss.test.ts` (the real queue, end to end)
- **409 on a stale step version:** `approvals-edit.test.ts` (stale PATCH, concurrent edits); `approvals-approve.test.ts` (stale approve, double-click, overlap)
- **Partial approval:** `approvals-approve.test.ts` "partial approval: the office approves a text and an ad..."; the same test then has the owner approve the waiting ad and the task finishes `done`
- **Retry does not repeat a completed effect:** `runner.test.ts` (retry route, same idempotency key, double-click); `send-batch.test.ts` ("running the step again texts nobody twice", provider failure then retry); `dispatcher.test.ts`
- **Expiry:** `scheduler.test.ts` (expiry job, rerun once); `approvals-approve.test.ts` (an expired draft cannot be approved)
- **Every edit and approval writes `audit_log`:** `task.create`, `step.edit`, `task.approve`, `task.decline`, `step.decline`, `step.retry`, `task.rerun` each asserted in `approvals-edit.test.ts`, `approvals-approve.test.ts`, `runner.test.ts`, `scheduler.test.ts`

## Send gate
- **Every rule has its own unit test:** `packages/send-gate/test/decide.test.ts` (billing, registration, contact, consent, content, dedupe, weekly cap, rule order, quiet hours, fail-closed input)
- **FL / OK / MD:** `decide.test.ts` (20:00 cutoff; 3 per 24 hours)
- **15-minute reply exception:** `decide.test.ts` ("the reply exception")
- **Time-zone and DST edges:** `packages/send-gate/test/quiet-hours.test.ts` (spring-forward 2026-03-08, fall-back 2026-11-01, month and year ends, Indiana zone); `packages/shared/test/time-zone.test.ts` (`isTimeZone`)
- **STOP, HELP, START wording:** `packages/send-gate/test/inbound.test.ts`
- **`send_sms_batch` with mixed recipients gives the right send, schedule and block counts in `result`:** `send-batch.test.ts` ("the brief's five"); `dispatcher.test.ts` (the step result after dispatch)
- **STOP after a text was scheduled: the dispatcher's re-check blocks it:**
  - `twilio-hooks.test.ts` "a STOP that arrives after a text was scheduled": the real webhook, then the dispatcher (added in Task 19).
  - `dispatcher.test.ts` (overnight table: STOP, do-not-contact, consent withdrawn, archived, billing lapse, weekly cap).

## Pricing
- `packages/shared/test/pricing.test.ts` ports `v1/tests/pricing.test.ts`: 5 tests, 16 assertions on each side, same inputs and expected values.

## v1
- `cd v1 && npm test`: 28 tests pass. `npm ci --dry-run` is clean for both lockfiles. CI runs `npm ci && npm test` in `v1/`.

## Import boundary (Task 19)
- `apps/api/test/boundaries.test.ts` runs the real ESLint config: `@roofline/db/system` is an error in routes, messaging, tasks, send-gate and shared, and allowed in auth, hooks, `jobs/scheduler`, scripts, the worker, `packages/db` and test folders.

## Gaps and notes
- **No acceptance item is without a test.**
- **Billing and CSV import rows** of the permission matrix are covered at the `can()` level only. Their routes arrive in F3.
- **Manual smoke items:** none in F1 (Stripe, Twilio and the rest are faked; no live calls in CI).
- **`npm start` for v1** is not run by any automated test; its suite and `npm ci` are.
- **Raw-SQL isolation "wrong setting"** is tested as another company's id. A malformed (non-UUID) setting value is not separately tested.
