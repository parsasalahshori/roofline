## Global Constraints

**Code and repo (from F1/F2)**
- **Language and modules:** Node ≥ 22.13, TypeScript strict, ESM. Relative imports carry explicit `.ts`/`.tsx` extensions.
- **Enum columns:** `text` with drizzle `{ enum }` plus a CHECK (`enumCheck`), never `pgEnum` (R10).
- **Tenant tables:**
  - Each has `company_id uuid not null`.
  - Each is listed in `TENANT_TABLES`.
  - Each gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy, using exactly `company_id = nullif(current_setting('app.company_id', true), '')::uuid`.
  - Links between tenant tables are composite `(company_id, x_id)` foreign keys.
- **`app_system` on tenant tables:** column-level SELECT only, plus an `app_system_all` policy on each such table (the `rls.test.ts` rule).
- **`@roofline/db/system` imports:** only from `apps/api/src/{auth,hooks,jobs/scheduler,scripts,account,public}/**`, `apps/worker/**`, `packages/db/**` and tests. `account` and `public` are new in Task 9.
- **No raw query path from routes:** every tenant read and write goes through `packages/db` repos inside `withTenant`.
- **Error bodies:** `{ error: "<plain English>", field? }`. Never a stack trace, a code, a vendor message, a phone number or a message body.
- **Provider error messages:** text from a provider is never stored, shown or logged, because Twilio's messages echo phone numbers. Keep the code and the HTTP status only.
- **Message constants:** F3 keeps its plain-English messages as constants in its own modules, not in `errors.ts` `MESSAGES`.
- **Secrets:** only from env, read in `config.ts`. Never in code, never in a URL we log, never in an error.

**Billing (spec §5.1–5.2, verbatim)**
- **Trial and card:**
  - "No credit card to start: a **14-day trial** begins."
  - "Card and plan required before anything that costs money: texting registration submission, buying a phone number, ordering exact reports."
  - Checkout runs "Stripe Checkout in subscription mode". "The subscription starts with its trial ending on the company's `trial_ends_at`."
  - "Usage during the trial is billed normally; the trial covers only the monthly fee."
- **Trial ends without a card:** `status=trial_ended`. The app is read-only; the send gate blocks with rule `billing`. A banner offers "Pick a plan to keep going". Data is kept for 90 days.
- **Plans:**
  - Shape: `{key, name, monthly_price_cents, included: {ai_call_minutes, sms_segments}, overage_cents: {ai_call_minute, sms_segment}}`.
  - "Prices are business configuration set by the owner before launch. The code has no hard-coded prices."
- **Metering:**
  - "Fixed-unit usage (`ai_call_minute`, `sms_segment`; MMS counts as 3 segments) is reported to one Stripe Billing Meter per kind within 5 minutes (batched job)."
  - Metered prices use "graduated tiers, with the first tier free up to the included amount".
- **Invoice items:**
  - Exact reports: "Roofline's cost × (1 + markup % from config)".
  - Texting registration fees and phone number monthly fees: "passed through at cost".
  - Each has a plain description such as "Exact roof report — 812 Oak St".
- **Webhooks:** `POST /hooks/stripe`, signature verified. Events: subscription created, updated or deleted; invoice paid or payment failed.
- **Past-due banner, verbatim:** "Your payment didn't go through. Texts and calls are paused until it's fixed," with a button to the Stripe customer portal.
- **Billing page:** current plan, usage so far this period (by kind, with the included amount), invoices (Stripe portal link), and change plan.

**Setup checklist (spec §5.3)**
- **`setup_items` table:** `company_id`, `key`, `status (todo|in_progress|waiting|done|skipped)`, `data jsonb`, `updated_at`.
- **Keys, in order:** `company_basics`, `import_customers`, `texting_registration`, `invite_team`, `payment_method`, `prices_and_tiers`, `connect_calendar`, `phone_number`, `connect_ads`.
- **Texting waiting state:** "Waiting on phone carriers (usually 10–15 days)".
- **Later-spec items** show "Coming with [feature]". The checklist never blocks using the app; it shows as a progress ring in the user menu until complete.

**Import (spec §5.4)**
- **File:** CSV or XLSX, up to 20,000 rows, converted on the server.
- **Header synonyms:** name/first/last, phone/mobile/cell, email, address/street, city, state, zip, notes, stage.
- **Preview:**
  - the first 20 rows as they'll be saved
  - counts: new, matches an existing customer (by phone E.164 or email; updated, not duplicated), will be skipped (no name, no phone and no email, bad phone)
- **Consent text, verbatim:** "These customers agreed to receive text messages from [Company]. I understand [Company] is responsible for having their consent."
- **Box checked:** **new** customers with phones get `sms_consent_status=attested`, `source=import`, `by=user`, `at=now`, evidence `{import_id, text}`.
- **Box unchecked:** **new** customers get `express`.
- **Existing (matched) customers:**
  - never raised from `revoked`, `do_not_contact` or an `opt_outs` row
  - never lowered (`written` stays `written`, `attested` stays `attested`)
  - only `none` → `express`/`attested` and `express` → `attested`
  - `do_not_contact` is never cleared
- **Preview line:** "12 customers previously opted out, and their texting stays off".
- **Processing:** a background job, geocoded in batches. Jobs are created only when a stage column is mapped, with that stage and `source=import`. A progress bar shows while it runs; at the end there is a summary and a downloadable skipped-rows CSV.
- **Audit:** the import and the consent confirmation are written to `audit_log`.

**Texting registration (spec §5.5)**
- **Sign-up:** a subaccount is created per company, at no cost.
- **Brand info:** legal name, EIN, business type, address, website, contact name, email and phone.
- **Default use case:** "Customer care + marketing (mixed)", with sample messages from our templates.
- **Number:** one local number with voice and SMS, in the company's area code, in `company_phone_numbers` with `purpose=main`. Its monthly fee is a usage event.
- **Hosted pages:** `https://<company-slug>.<app-domain>/privacy` and `/terms`.
- **Status:** Twilio status callbacks plus a daily poll.
- **Rejection:** a plain reason plus **Fix and resubmit** with the fields highlighted.
- **Send gate:** rule order `billing, registration, contact, consent, content, dedupe, frequency, quiet_hours` (unchanged). F3 adds checks only inside `contact`.

**Errors and reliability (spec §6)**
- **Provider failures:** retried with exponential backoff, up to 5 attempts, through pg-boss.
- **After the last attempt:** a plain `error_plain` such as "Couldn't reach the texting service. We'll keep trying; you can also retry now".
- **Webhooks:** idempotent by provider event id.

**Web (F2 rules apply to every F3 screen)**
- **Strings:** every UI string lives in `apps/web/src/copy/*.ts`. No literal text in JSX. No raw `<button>`.
- **Banned whole words in copy:** `JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`, and every snake_case value of an `as const` array exported by `@roofline/shared` (F3 adds several, such as `company_basics`, `ai_call_minute` and `non_profit`). Copy objects use unquoted camelCase keys.
- **Vendor names** (`Twilio`, `Google`, `Meta`, `Facebook`, `Stripe`, `Outlook`, `Microsoft`, `EagleView`, `MapTiler`) appear only in `copy/connections.ts`, `copy/setup.ts`, `copy/auth.ts`, `copy/billing.ts` and `copy/legal.ts`.
- **Limits:**
  - at least 12px type
  - WCAG AA contrast
  - keyboard reachable
  - 40px touch targets on phone
  - no horizontal scroll at 375px
- **Feature hooks:** in `apps/web/src/features/<feature>/api.ts`, built on F2's `apiFetch`/`ApiError` (`apps/web/src/api/client.ts`) and `keys`.

**Tests (spec §7)**
- **No live provider calls in tests or CI.** Stripe, Twilio, Geocodio and Postmark go through fakes or recorded responses.
- **Stripe webhooks** are signed in tests with the test secret `whsec_test_roofline`.
- **Stripe test clocks** run only in the manual smoke suite (Task 37).
- **Playwright** runs desktop 1440×900 and phone 375×812, through F2's `apps/web/e2e/stack.ts`.

## Review Focus
