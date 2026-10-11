### Task 28: Registration progress: callbacks, poll, number, fees

**Base:** `f3-setup` after Tasks 25, 26 and 27 are merged (chain 27 → 28 on `system/texting.ts`). From T27: `RegistrationRecord`, `loadRegistration`, `updateRegistration`, `withRegistrationLock`, `subaccountRef`, `advanceRegistration` (stage 1, which calls `continueRegistration` at the end), `textingView`. From T25/T26: `TwilioAccounts`, `TwilioBrands`, `apps/api/test/twilio-fixtures.ts` (`fixtureFetch`, `fixture`) and the `test/fixtures/twilio/*.json` files. From T9: stubs `apps/api/src/account/texting/progress.ts` (`continueRegistration`), `apps/api/src/hooks/twilio-registration.ts` (`twilioRegistrationHooks(deps)`, mounted at `/hooks/twilio-registration` **before** the JSON parser — it must parse its own bodies), `apps/api/src/jobs/scheduler/{poll-texting,bill-monthly-fees}.ts` (`pollTexting` hourly `0 * * * *`, `billMonthlyFees` `0 9 1 * *`), `billingConfig`, `hasPaymentMethod`. From T17: `policyUrls`. From T5: `buildCampaign`, `plainRejection`, `displayUsPhone`. Existing: `signingTokenFor` (`system/routing.ts`), `recordUsage`, `company_phone_numbers` (`e164` unique, `capabilities text[]`, `provider_sid`, `purpose` `'main'`, `status` text default `'active'`; app_system writes).

**Split:**
- Builder 1: `apps/api/src/account/texting/progress.ts`.
- Builder 2: `apps/api/src/hooks/twilio-registration.ts`, `apps/api/src/jobs/scheduler/poll-texting.ts` and the `packages/db/src/system/texting.ts` additions.
- Builder 3: `apps/api/src/jobs/scheduler/bill-monthly-fees.ts` and the tests.

**Files:**
- Modify: `apps/api/src/account/texting/progress.ts`, `apps/api/src/hooks/twilio-registration.ts`, `apps/api/src/jobs/scheduler/{poll-texting,bill-monthly-fees}.ts`, `packages/db/src/system/texting.ts` (append)
- Test: `apps/api/test/texting-progress.test.ts`, `apps/api/test/texting-recorded.test.ts`
- Do not touch: `advance.ts`, `texting-routes.ts`, `view.ts` (T27), `providers/**`, `test/twilio-fixtures.ts`.

**Interfaces:**
```ts
// progress.ts
export async function continueRegistration(deps: AppDeps, companyId: string): Promise<void>;
// system/texting.ts (append)
export async function companyIdForTextingSid(system: Db, sid: string): Promise<string | null>;   // matches subaccount, customer_profile, trust_product, brand, campaign or messaging_service sid
export async function registrationsToCheck(system: Db, now: Date): Promise<string[]>;
export async function addMainNumber(system: Db, companyId: string, n: { e164: string; providerSid: string; capabilities: string[] }): Promise<void>;   // purpose 'main', status 'active'; idempotent on e164
export async function companiesWithTextingFees(system: Db): Promise<string[]>;   // an active main number or an approved campaign
// scheduler
export async function pollTexting(deps: AppDeps, now: Date): Promise<void>;
export async function billMonthlyFees(deps: AppDeps, now: Date): Promise<void>;
```
- **`continueRegistration`,** under `withRegistrationLock` (`'busy'` → return); every pass sets `last_checked_at = now`; steps run in order and each may fall through to the next in the same pass:
  1. **Brand pending** (`brand_status 'pending'`) → `brandStatus`: `failed` → `brand_status 'failed'`, `campaign_status 'rejected'`, reason/fields from `plainRejection(failureReason)` (T27's stage 1 resubmits a `failed` brand, Ruling AE); `approved` → `brand_status 'approved'`.
  2. **Brand approved, campaign to (re)submit** — when `brand_status = 'approved'` and `campaign_sid` is null, or `brand_status = 'campaign_failed'` (proposed Ruling AF, below): `ensureMessagingService(sub, companyId, { inbound: PUBLIC_BASE_URL + '/hooks/twilio/sms', status: PUBLIC_BASE_URL + '/hooks/twilio/status' })`; `submitCampaign({ brandSid, messagingServiceSid, campaign: buildCampaign({ companyName, companyPhone, privacyUrl, termsUrl }) /* urls from policyUrls(config, slug) */, previousCampaignSid: brand_status === 'campaign_failed' ? campaign_sid : null })`; save `messaging_service_sid`, the new `campaign_sid`, `brand_status 'approved'`; fee `texting_registration_fee`, unit `pass_through_cents.campaign_vetting`, ref `('texting_campaign', campaignSid)`, "Texting registration: carrier review".
     - **Ruling AF:** a campaign failure is marked by `brand_status = 'campaign_failed'` (the column is plain text; the brand itself stays approved). The failed `campaign_sid` stays in its column, so the resubmission can delete it. T27's stage 1 (which runs on `brand_status` null/`failed`) and `saveSubmission` need no change: after the owner resubmits, `campaign_status` is `pending` again and this step resubmits the campaign only.
  3. **Campaign pending** (`campaign_sid` set, `brand_status 'approved'`, `campaign_status 'pending'`) → `campaignStatus`: `failed` → `campaign_status 'rejected'`, `brand_status 'campaign_failed'`, reason/fields from `plainRejection(failureReason)`; `approved` → continue to 4; `pending` → stop.
  4. **Campaign approved, no active main number:** only while `hasPaymentMethod` (company `stripe_subscription_id` + status `active`/`past_due`; **`past_due` counts as no card here** per the plan's test, so require status `active`); `ensureNumber(sub, { messagingServiceSid, areaCode: <NPA of companies.phone_e164, else null>, state: companies.address_state })`; `addMainNumber`; fee `phone_number_month`, unit `pass_through_cents.phone_number_monthly`, ref `('phone_number', <PN sid>:<YYYY-MM>)` (month in the company zone), description `Texting number ${displayUsPhone(e164)} — ${Month YYYY}` (e.g. "Texting number (402) 555-0100 — October 2026"); `campaign_status 'approved'`, `approved_at = now`.
- **`POST /hooks/twilio-registration`:** its router parses `express.urlencoded({ extended: false, limit: '64kb' })` and `express.json({ limit: '64kb' })`. Every string value (top level and one level down) matching `/^(AC|BU|BN|QE|MG)[0-9a-f]{32}$/` is tried with `companyIdForTextingSid`; none → 404 empty. The signature `X-Twilio-Signature` is checked with `twilio.validateRequest(signingTokenFor(...), sig, PUBLIC_BASE_URL + req.originalUrl, params)` (for a JSON body, validate with `validateRequestWithBody`); failure → 403 empty. Then `deps.jobs.send('texting-registration', { companyId }, { singletonKey: companyId })` → 200 empty. The payload's statuses are never used.
- **`registrationsToCheck(system, now)`:** `campaign_status = 'pending'` and: brand stage (no `campaign_sid`) with `last_checked_at` null or older than 1 hour; campaign stage with `last_checked_at` null or older than 24 hours; plus submitted rows with no `brand_sid` whose `submitted_at` is over 1 hour old (a stuck stage 1).
- **`pollTexting`:** returns when `!deps.registrar.configured`; for each id, `advanceRegistration(deps, id)` in a try/catch (`deps.logError`).
- **`billMonthlyFees(deps, now)`:** for each `companiesWithTextingFees`, month = `now` in the company zone as `YYYY-MM`: each active main number → `phone_number_month`, ref `('phone_number', <PN>:<YYYY-MM>)`, same description format; each approved campaign → `texting_registration_fee`, unit `pass_through_cents.campaign_monthly`, ref `('texting_campaign_month', <QE>:<YYYY-MM>)`, "Texting registration: monthly carrier fee — October 2026". The unique ref makes a rerun a no-op.

**Tests:**
- `texting-progress.test.ts` (fake registrar; seed a submitted registration via T27's route + drain):
  - `test("brand approved → campaign submitted with the company's details, fee once")`: `t.registrar.setBrand('approved')`, advance ×2 → `ensureMessagingService` URLs as above; the `submitCampaign` campaign equals `buildCampaign(...)` for Acme; one 1500 fee row.
  - `test('campaign approved → a number in the area code, saved as main, texting on')`: company phone `+14025550199`, status `active` with a subscription → `ensureNumber` called with `{ areaCode: '402', state: 'NE' }`; the `company_phone_numbers` row is `main`/`active` with e164 `+14025550100`; `GET /api/texting` → `state 'approved'`, `number '+14025550100'`; `textingCompanyFacts(...).campaignStatus === 'approved'`.
  - `test('a failed campaign shows Fix and resubmit')` → `needs_fix` with the plain reason.
  - `test('buying the number waits for a working card')`: `past_due` → no `ensureNumber`; `active` → bought.
  - `test('a signed callback wakes the registration')`: a form POST signed with the subaccount token (`twilio.getExpectedTwilioSignature`) carrying `BrandRegistrationSid=<BN>` → 200 and `t.jobs.sent` gains one; a bad signature → 403; an unknown sid → 404.
  - `test('the poll checks brands hourly and campaigns daily')`: with the clock, `registrationsToCheck` includes/excludes at 59 min / 61 min and 23 h / 25 h.
  - `test('monthly fees are recorded once per month')`: two runs on 2026-11-01 → one number row and one campaign row; on 2026-12-01 → two more.
- `texting-recorded.test.ts`: `test("with Twilio's recorded answers, a registration goes from submitted to approved, and a rejection to Fix and resubmit")` — build `deps.registrar` from real `TwilioAccounts` + `TwilioBrands` over `fixtureFetch` (sequences: `brand-pending` then `brand-approved`; `campaign-pending` then `campaign-verified`; the failed path with `brand-failed`), make the app with that registrar, submit through the route, drain and advance → `waiting` → `approved` with a main number row; on the failed path, `needs_fix` with a plain reason (never Twilio's text).

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(texting): registration progress by callback and poll; main number and monthly fees`.
