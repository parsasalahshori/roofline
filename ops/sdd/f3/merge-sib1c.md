# Merge notes: sibling 1, F3 group G2 (T16 f3-t16, T21 f3-t21, T22 f3-t22)

Group check by Opus contact 24 (workflow run wf_54c0bcd6-65d). Base for all three: f3-setup 74ee852.

Heads: f3-t16 d62490e, f3-t21 5e62c02, f3-t22 ec35ecd.

Parked (controller request): the early_delivery_reports prune sweep was NOT given to T22. A new sweep needs a SCHEDULES entry in jobs/worker.ts, which the T22 brief forbids touching, so it does not fit the brief's pattern. It needs its own small task: a system repo delete (unapplied reports older than 7 days) plus a jobs/scheduler file plus a SCHEDULES line.

CI note: on T16 and T21 the E2E job failed once on e2e/shell.spec.ts "dock has six labeled apps..." (timeout on the 6th app, Agents). Neither branch touches web code, and the base and T22 passed. The test opens six windows inside one 30 s test budget, so it is likely a timing flake; the failed jobs were re-run once (see the controller message for the result).

## Merge notes

No file overlap and no merge conflicts expected. T16 touches apps/api/src/account/setup-routes.ts, packages/db/src/repos/setup.ts and apps/api/test/setup.test.ts. T21 touches apps/api/src/auth/sessions.ts, apps/api/src/billing/read-only.ts, apps/api/src/jobs/scheduler/end-trials.ts, packages/db/src/system/auth.ts, packages/db/src/system/trials.ts and two new tests. T22 touches apps/api/src/jobs/scheduler/report-usage.ts, packages/db/src/repos/usage.ts, packages/db/src/system/usage-fanout.ts and one new test. No task edits a barrel file. Base 74ee852 already exports repos/setup.ts and repos/usage.ts from packages/db/src/index.ts, and system/trials.ts and system/usage-fanout.ts from packages/db/src/system/index.ts. All three branches start from 74ee852, so they can merge in any order; I suggest T21, then T16, then T22.

Interfaces fit together. T21 adds companyStatus to SessionRecord (findLiveSession now inner-joins companies) and to SessionInfo. The `{ lastSeenAt, ...session }` spread in sessions.ts carries it through. The base code has no other SessionInfo object literals, so T16 and T22 compile against it. Statuses agree across tasks: T16's paymentMethod fact (stripe_subscription_id set and status in active or past_due) is false for T21's trial_ended and canceled, and T21 also leaves past_due writable. T22 uses only base-shared helpers (meterUnits, METER_EVENT_NAME, INVOICE_KINDS, invoiceAmountCents) and the base BillingProvider (configured, reportMeterEvent, createInvoiceItem). In meterUnits, mms maps to the sms_segment meter, so T22 sharing one batch id between sms_segment and mms rows is consistent.

There are no duplicated helpers. T21 and T22 both use systemContext plus reportJobError per company in the same pattern. Plain-English messages stay in their own modules (T16's CANNOT_SKIP, T21's READ_ONLY_MESSAGE) under Ruling 33. T21's 403 returns the same { error } body as ErrorBody. None of the three tasks touches web or UI code, so the copy and JSX lint rules do not apply.

After merging, run typecheck via the slot wrapper. CI should run all three DB-backed test files together: setup.test.ts, read-only.test.ts plus end-trials.test.ts, and report-usage.test.ts.

## Issues

- **minor** (tasks 16, 21): T21's readOnlyGuard (mounted on /api ahead of every router) returns 403 for every non-GET request outside /auth/, /billing/ and /me/. That includes T16's POST /api/setup/:key/skip and /unskip, so a trial_ended or canceled company cannot skip or unskip setup steps. T16's GET /api/setup still works, and it upserts setup_items on every read. Nothing tests how the two behave together.
  - Suggestion: Decide whether this is intended. It probably is: skipping is a write. If so, leave it and maybe add one assertion to read-only.test.ts after the merge. If not, add '/setup/' to ALWAYS_OPEN_PREFIXES in apps/api/src/billing/read-only.ts.
- **minor** (tasks 21): Every ALWAYS_OPEN_PREFIXES entry ends in a slash ('/billing/', '/me/', '/auth/'). A write to the root of one of those routers (req.path exactly '/billing' or '/me') is therefore refused in read-only mode, even though the docs say billing stays open.
  - Suggestion: Match path === prefix-without-slash || path.startsWith(prefix). Alternatively, confirm that no POST, PATCH or PUT route is mounted at the root of /api/billing or /api/me.
- **minor** (tasks 22): companiesWithUnreportedUsage lists every company with any row where reported_to_stripe_at is null. Two cases keep a company on that list forever, so it is re-scanned every minute: an INVOICE_KINDS row with a null unit_cost_cents (unbilledInvoiceUsage skips it), and a company with no Stripe customer. This does not conflict with T16 or T21. It is noted because T21 adds trial_ended companies, which may never get a customer.
  - Suggestion: Acceptable for now. Optionally narrow the fan-out query, or mention it in the T22 notes.
