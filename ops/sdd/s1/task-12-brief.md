### Task 12: `send_email_batch` handler and the email send path

**Base:** `s1-storm` after Tasks 6 and 7 are merged. From T6: `decideEmail`. From T7: `BroadcastMailer`, `FakeBroadcastMailer`. Real (F3): the lease loop pattern in `messaging/send-batch.ts` (`leaseKeeper`, `lease.keep()`), `messaging/dispatcher.ts` (scheduled sends), `messages` table (gains `to_email`, `subject` in T1).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `storm/email-batch.ts` (lease loop like `send-batch.ts`: `if (!(await lease.keep())) return { status: 'running', result: {} };` first in the per-customer loop; gate per recipient; insert `messages` rows `channel 'email'`); Builder 2 `repos/email-sends.ts` (dedupe and the 7-day count by address; unsubscribe tokens); Builder 3 tests.

**Files:** Fill `apps/api/src/storm/email-batch.ts`, `packages/db/src/repos/{email-sends,email-opt-outs}.ts`; Modify `apps/api/src/tasks/handlers.ts` (swap its own stub, Ruling 2); Test `apps/api/test/email-batch.test.ts`.

**Interfaces:**
```ts
export const sendEmailBatchHandler: StepHandler<'send_email_batch'>;
// per recipient: render subject/body with fields + company_address + unsubscribe = `${APP_ORIGIN}/u/${token}` (token = `signUnsubscribeToken(unsubscribeKey(config), …)` from Task 13's `public/unsubscribe-token.ts` and `public/unsubscribe-key.ts`, which replaces Ruling 5's HMAC; the app has no SESSION_SECRET)
// gate: decideEmail; blocked → messages row status 'blocked' with rule/reason (as SMS); quiet hours → scheduled row picked up by the F1 dispatcher's email branch (Task 12 adds `dispatchEmail` beside the SMS dispatcher, same claim pattern)
// send: deps.broadcast.send({ from: `"${company} via Roofline" <${STORM_MAIL_FROM}>`, replyTo: company email, tag: `storm:${companyStormId}` })
// result: { sent, blocked: { [rule]: n }, scheduled }
```

**Tests:**
- gate counts; opted-out skipped; dedupe on re-run; lease loss returns running; scheduled emails dispatch after 8 AM local; HTML and text both carry the unsubscribe URL; a provider error marks the row failed and continues.

**Carries and rulings:**
- Swap only this task's stub in `tasks/handlers.ts`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): storm emails through the email gate with unsubscribe links`
