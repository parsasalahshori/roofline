### Task R10 (Ruling BF, security review finding 3 Medium): SMS consent only from a verified phone; a fair per-page budget

**Base:** `s1-storm` 83e9856. Source: `ops/sdd/integration/security-review.md` on `origin/sec-review` (finding 3). API and db repos.

**Fixes:**
1. **The form never writes express consent.**
   - `public/storm-requests.ts`, `storm/landing.ts` and `packages/db/src/repos/storm-requests.ts` currently give `express` consent (source `web_form`) to any phone with okToText. They also upgrade an existing customer at `none` (`upgradeConsent`).
   - Change both: the form records the request with `sms_consent` (the homeowner's ask) and its consent text and time as evidence only. It never creates or upgrades `customers` consent. An existing customer's consent is never changed by the public form.
2. **A reply from the phone verifies it.**
   - The phone is verified when a Twilio-signed inbound text from that number replies YES (`isYesReply`) within 14 days of a storm request that asked to be texted.
   - Wire this in the Twilio inbound hook next to `onStormReply` (`apps/api/src/storm/replies.ts`, `hooks/twilio.ts`). Only then record `express` consent (source `web_form`), with the request as evidence plus the reply message id, and audit it.
   - STOP and HELP keep their precedence.
   - Do not send any automatic text to the number from the form. That would be an SMS-bombing vector. The owner's normal follow-up (a call, or a reply to the homeowner's text) is how a YES arrives.
3. **Fair budget.**
   - Keep the per-page hourly budget. Also cap each IP's share of one page, so it takes at least about 25 IPs to fill the page: for example 2 per IP per page per hour against a page budget of 50.
   - Add a per-phone cap: one request per phone per page per day. Extras are accepted silently with no new customer or job, or answered with the same thank-you page. Choose and record which.
   - Put the numbers in `landing-copy.ts` or wherever the existing limits live.
   - Note in the report that per-IP limits depend on F2/F3 finding 4 (`TRUST_PROXY`).
4. **Tests (API and db):**
   - The form leaves consent at `none` for a new and an existing customer.
   - A YES from that phone within 14 days makes it `express`, with evidence; after 14 days, or from another number, nothing changes.
   - The per-IP share and per-phone caps hold.
   - Update every existing test that expected express consent from the form, and the results counters if `wantsCheck` or `yesReplies` depend on it.

**Do not touch:** ad accounts or 0018 (R8); the unsubscribe page, `errors.ts` or public-route limiters (R9). If you need a column, add it to the drizzle schema and amend `0017_storm_schema.sql` plus `meta/0017_snapshot.json` in place (both are unreleased, as in Ruling AW), so drizzle-kit reports no changes. Prefer no schema change.
**Verify:** typecheck, lint, drizzle-kit no changes. ci-check `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(storm): storm form consent waits for a verified YES; per-IP and per-phone caps (Ruling BF)`
