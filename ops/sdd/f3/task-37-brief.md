### Task 37: The manual smoke suite (Stripe test clock, a real test brand)

**Base:** `f3-setup` after Tasks 18, 25 and 26 are merged. From T18: `StripeBillingProvider`, `billing/stripe-sync.ts`, the `sync:stripe-plans` script (pattern for a script with flags), the `stripe` SDK. From T25/T26: `TwilioAccounts`, `TwilioBrands`, `SECONDARY_PROFILE_POLICY`, `A2P_PROFILE_POLICY`; from T13: `TwilioHttp`. From T3: `priceLookupKeys`, `METER_EVENT_NAME`. From T5: `BrandInfoSchema`, `buildCampaign`. `loadConfigOrExit` (`deps.ts`). **These scripts are run only by hand, by the owner, with real test credentials. Nothing in CI or the unit suite calls a provider.** No agent in this task runs them.

**Split:**
- Builder 1: `apps/api/src/scripts/smoke/stripe-test-clock.ts`.
- Builder 2: `apps/api/src/scripts/smoke/texting-real-brand.ts` and `apps/api/src/scripts/smoke/guards.ts`.
- Builder 3: `docs/superpowers/f3-manual-smoke.md`, the two `package.json` scripts, and `apps/api/test/smoke-guards.test.ts`.

**Files:**
- Create: `apps/api/src/scripts/smoke/{guards,stripe-test-clock,texting-real-brand}.ts`, `docs/superpowers/f3-manual-smoke.md`
- Modify: `apps/api/package.json` (`"smoke:stripe": "tsx src/scripts/smoke/stripe-test-clock.ts"`, `"smoke:texting": "tsx src/scripts/smoke/texting-real-brand.ts"` only; no dependency changes)
- Test: `apps/api/test/smoke-guards.test.ts`

**Interfaces:**
```ts
// smoke/guards.ts
export class SmokeRefused extends Error {}
export function assertStripeTestKey(key: string | undefined): string;   // returns the key; throws SmokeRefused("Use a Stripe test key (sk_test_…) for the smoke run.") unless it starts with sk_test_
export function assertConfirmed(argv: readonly string[], flag: '--confirm-real-registration'): void;   // throws SmokeRefused("This makes a real registration with the phone carriers and costs money. Pass --confirm-real-registration if you mean it.") unless argv includes flag
export function parseSmokeBrand(json: string | undefined): BrandInfo;   // SMOKE_BRAND_JSON through BrandInfoSchema; throws SmokeRefused naming the bad fields (never the values)
```
- **`smoke:stripe`** (`STRIPE_SECRET_KEY` through `assertStripeTestKey`; plans already synced with `sync:stripe-plans`):
  1. `testHelpers.testClocks.create({ frozen_time: now })`; a customer on the clock with `payment_method: 'pm_card_visa'` set as the default invoice payment method.
  2. Subscribe to the starter prices (found by lookup key: `priceLookupKeys('starter')`) with `trial_end` = clock time + 14 days.
  3. Report meter events (`roofline_sms_segment` value 6, `roofline_ai_call_minute` value 4, each with a fresh `identifier`) and an invoice item of 5400 "Exact roof report — 812 Oak St (smoke)".
  4. Advance the clock 15 days (`testClocks.advance`) and poll until `status === 'ready'` (timeout 5 minutes, printing progress).
  5. Print the latest invoice's lines and amounts and the dashboard links (`https://dashboard.stripe.com/test/…`). Never print the key.
- **`smoke:texting`** (`assertConfirmed(argv, '--confirm-real-registration')`, `SMOKE_BRAND_JSON` = Roofline's own brand via `parseSmokeBrand`; needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PRIMARY_PROFILE_SID`): runs `TwilioAccounts`/`TwilioBrands` against a dedicated subaccount `roofline:smoke` (companyId string `smoke`), keeping the returned sids in a local JSON state file given by `--state <path>` (default `.smoke-texting.json`, git-ignored — add the line to `.gitignore`). Modes: `--submit` (subaccount, brand); `--status` (prints brand and campaign statuses, plain words); `--campaign` (messaging service + campaign with `buildCampaign({ companyName: brand.legalName, companyPhone: brand.contactPhone, privacyUrl, termsUrl })`, the policy URLs from `--privacy-url`/`--terms-url`, only once the brand is approved). Output never includes tokens.
- **Runbook (`docs/superpowers/f3-manual-smoke.md`):** for each check — the command, the env it needs, and the expected result:
  - Stripe: the dashboard shows the two meter events and the invoice item on the test clock's invoice, with the starter tiers applied (metered lines at $0 inside the included amounts).
  - Texting: one real registration of Roofline's test brand moves to approved (expect days; re-run `--status`).
  - The hosted pages render on the real domain (`https://<slug>.<POLICY_PAGES_DOMAIN>/privacy` and `/terms`).
  - Geocodio answers for one known address (a one-line `tsx -e` with `GeocodioGeocoder`), and the API version in `providers/geocodio.ts` is current (Ruling 31).
  - Postmark delivers a test email (the reset-password flow on a real address).
  - The TrustHub policy SIDs in `providers/twilio/brands.ts` match Twilio's ISV guide.
  - A sign-off table (date, who, result) at the end.

**Tests (`smoke-guards.test.ts`)** — pure, no provider:
- `assertStripeTestKey('sk_live_x')` throws `SmokeRefused`; `assertStripeTestKey(undefined)` throws; `assertStripeTestKey('sk_test_x')` returns it.
- `assertConfirmed([], '--confirm-real-registration')` throws; with the flag it does not.
- `parseSmokeBrand('{}')` throws a message naming fields and containing no values.

**Verify notes:**
- Locally `npm run typecheck && npm run lint`; the guard test is in the api project (Docker-only globalSetup) → prove with `ops/bin/ci-check`. **Never run `smoke:*`.**
- Commit: `test(smoke): Stripe test-clock run and a real test-brand registration, by hand only`.
