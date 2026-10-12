# Merge notes, sibling 2f (F3 Tasks 28, 37; Opus contact 46, run wf_dc0ff4bd-0a5)

| Task | Branch | Head | CI run (Platform) |
|---|---|---|---|
| 28 registration progress | f3-t28 | 1e1a962 | 38193810297 passed |
| 37 manual smoke suite | f3-t37 | 3dc24d9 | 38193748890 passed |

Both branch from f3-setup 330ca23. Both reviews were clean in round 1: no fixes, nothing parked.

Controller finding W4 (campaign_status 'approved' written only in the same transaction as addMainNumber) is already met. In progress.ts step 4, addMainNumber(tx, …) and updateRegistration(tx, { campaignStatus: 'approved' }) both use the withRegistrationLock transaction. One related point: the phone_number_month fee row is written through a separate withTenant transaction, so it can commit even if the lock transaction later rolls back. A retry then dedupes on the (phone_number, <PN sid>:<YYYY-MM>) ref only if ensureNumber returns the same PN; otherwise there is a stray fee row. That belongs with f3-review-c's duplicate-number-purchase fix.

## Group check merge notes

No file overlap. T28 touches apps/api/src/account/texting/progress.ts, hooks/twilio-registration.ts, jobs/scheduler/bill-monthly-fees.ts, jobs/scheduler/poll-texting.ts, packages/db/src/system/texting.ts and four new apps/api/test files. T37 touches .gitignore, apps/api/package.json (adds smoke:stripe and smoke:texting scripts), the new apps/api/src/scripts/smoke/{guards,stripe-test-clock,texting-real-brand}.ts, apps/api/test/smoke-guards.test.ts and docs/superpowers/f3-manual-smoke.md. Both branch from 330ca23, so the two merge into f3-setup in either order with no conflicts. There is no producer/consumer interface between them. T37 only uses provider classes that exist at base: TwilioAccounts, TwilioBrands, TwilioHttp, the registrar types, buildCampaign and loadConfigOrExit. T28 does not modify those. Everything T28 imports exists at base or is added in its own diff: advance.ts, signingTokenFor in system/routing.ts, and companyIdForTextingSid, registrationsToCheck and companiesWithTextingFees in system/texting.ts. No helpers are duplicated. No web/JSX files are touched, so the copy and JSX lint rules do not apply; T28's fee description string is API-side ledger text. Neither branch updates its ops/sdd/f3-setup/progress.md ledger entry or AGENTS.md, so the controller should record both tasks there after merging. After merging, run typecheck and lint through ops/bin/slot and the focused smoke-guards vitest locally (no DB). T28's texting-*.test.ts files are DB-backed and must run in CI through ops/bin/ci-check.

## Group check issues

- (minor) T28, T37: T37's texting smoke script uses example.invalid placeholder callback URLs, with optional SMOKE_STATUS_CALLBACK_URL and SMOKE_INBOUND_URL overrides. T28's real registration callback route is /hooks/twilio-registration. It finds the company by looking up a sid in texting_registrations (companyIdForTextingSid). The smoke run writes no DB rows (COMPANY_ID 'smoke'), so if the owner points SMOKE_STATUS_CALLBACK_URL at a deployed /hooks/twilio-registration, every callback gets a 404. That is harmless, but it may confuse whoever reads the Twilio debugger. The runbook does not say what the override is for. Suggestion: No code change is needed for the merge. Optionally, add one line to docs/superpowers/f3-manual-smoke.md (check b): leave the callback overrides unset, because the smoke brand is not stored in Roofline and the app's /hooks/twilio-registration would answer 404.

## Task minors

### T28
- apps/api/src/account/texting/progress.ts: the card check is inlined as `stripeSubscriptionId !== null && status === 'active'`. The brief names the existing `hasPaymentMethod` helper; it counts past_due as a card, so inlining is defensible, but a short comment pointing at the plan's test would make it clear this is deliberate.
- apps/api/test: no test covers the campaign_failed resubmission path (previousCampaignSid is passed, the failed campaign_sid is replaced, and the campaign fee is recorded again under the new sid). Ruling AF relies on this path; a short test with the fake registrar would cover it.
- apps/api/src/hooks/twilio-registration.ts: an unknown sid returns 404 before the signature is checked, as the brief specifies. This lets an unauthenticated caller tell whether a sid belongs to a company. It is acceptable per the brief and is only worth knowing.
- apps/api/src/account/texting/progress.ts step 4: if ensureNumber succeeds but a later write in the same transaction fails, the transaction rolls back and the retry calls ensureNumber again. This relies on ensureNumber being idempotent for the same messaging service; the recorded-fixture test covers only the success path.
- apps/api/src/jobs/scheduler/bill-monthly-fees.ts imports monthKey, monthLabel and numberFeeDescription from account/texting/progress.ts. A small shared helper module would be cleaner. This is not required.

### T37
- Neither smoke script has a test for argv parsing or flow. The brief asks only for the guard tests, so this is acceptable.
- stripe-test-clock.ts: the unused `argv` parameter is silenced with `void argv`. It could be named `_argv` instead.
- stripe-test-clock.ts: the catch-all prints only a generic sentence. That keeps the key and provider text out of the output, but the owner cannot tell which step failed. A step number in the message would help.

