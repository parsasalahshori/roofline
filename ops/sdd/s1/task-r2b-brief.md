### Task R2b (whole-branch review): consent and messaging fixes

**Base:** `s1-storm`. API and db only. Files: `apps/api/src/storm/replies.ts`, `apps/api/src/messaging/storm-text.ts` (and the render call in `messaging/send-batch.ts` only if needed), `apps/api/src/tasks/service.ts` (editStep guard only), `apps/api/src/messaging/dispatch-email.ts`, `packages/db/src/repos/storm-results.ts`, `apps/api/src/storm/alerts.ts`, `apps/api/src/jobs/scheduler/hail-health.ts`, `packages/db/migrations/0018_storm_grants_rls.sql` (email_opt_outs grant section only; Task R1 appends a separate section at the end, so keep your edit inside the existing email_opt_outs section) plus `packages/db/test/rls.test.ts` (email_opt_outs lines only), and tests. Do not touch `storm/plan.ts`, `settle.ts` or `routes/storms.ts` (Task R2a).

**Fixes:**
1. **(important) A YES can attach to a storm text that was never sent.** `newestStormText` has no status filter, so blocked, scheduled and failed texts count.
   - Filter `m.status in ('sent','delivered')` and order by `m.sent_at`.
   - Apply the same filter in `repliedYesBefore`'s anchor.
   - Test: a newer storm text blocked by the weekly cap does not capture the YES.
2. **(important) A storm text can be relabelled as informational.** Nothing stops an edit of a storm plan's `send_sms_batch` step from changing `purpose` to `informational` or removing `dedupePrefix`, which bypasses the marketing consent rules, the STOP text, the weekly cap and the FL/OK/MD rules.
   - In `editStep` (`tasks/service.ts`), for steps of a `storm_plan` task, reject an edit that changes `purpose` away from `marketing` or changes `dedupePrefix` (400 with field and a plain message).
   - Apply the same rule to `send_email_batch` (`purpose` stays `marketing`; `dedupePrefix` and `companyStormId` unchanged).
   - **Also, from the web review:** for a `create_ad_campaign` step, reject an edit that raises `maxSpendCents` or `days` above the approved draft's values. Lowering is allowed.
   - Tests.
3. **(important) The text's `{day}` is fixed at drafting time.**
   - Compute `day` in the SMS render at send time from the step's `companyStormId` and the company time zone, as `email-batch.ts` does for emails. A scheduled text sent the next morning then says "yesterday", not "today".
   - Keep Ruling SA: the render hook stays the only send-batch change, with the lease check first.
   - Test with a clock moved past midnight in the company zone.
4. **(minor) A scheduled email can carry the wrong unsubscribe link.** In `dispatch-email.ts`, when the customer's current email differs from the stored row's `to_email`, block the row with a plain reason (or re-render it with a fresh unsubscribe token). Never send a body whose link opts out a different address.
5. **(minor) Results over-count replies.** `storm-results.ts` counts only inbound texts within 14 days after the customer's plan text, and before their next storm text.
6. **(minor) A failed send loses the "hail now" alert.**
   - `claimNowAlert`: if every send fails, clear `alerted_at` so the next match alerts again.
   - Also alert any matched company storm whose `alerted_at` is still null (it covers a crash between the match commit and the alert).
7. **(minor) hail-health can only alert in one 15-minute window.** Alert on every tick past the stale threshold with a cooldown (for example 6 hours, kept in a small `ops_alerts`-free form: compute from the newest processed run and the tick time, or use the job queue's singleton key with a 6-hour window). Also alert when no run has ever been processed and the service has been up past the threshold.
8. **(minor) app_system can read every company's opted-out addresses.** `0018` grants app_system `SELECT (id, company_id, email)` on `email_opt_outs`. Check what `recordEmailOptOut` actually needs (RETURNING and ON CONFLICT), and drop `email` from the SELECT grant if possible (update `rls.test.ts`). If it is needed, document why in the migration comment. Keep drizzle-kit reporting no changes.

**Verify:** typecheck, lint, shared and send-gate tests; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(api): YES replies only to sent storm texts, storm steps keep marketing rules, send-time day labels, alert retries`
