# F3 acceptance checklist (spec section 5.6)

Status: the API, worker, database and unit tests below are database-backed and run in CI (`.github/workflows/ci.yml`, the Platform job). GitHub Actions was unavailable while F3 was finished (account billing), so nothing in this map has been run on CI yet. The new Playwright specs were only listed locally with `npx playwright test --list -c apps/web/playwright.config.ts` (every spec listed, no errors) and are proven on CI later; the E2E job already runs `--project desktop --project phone`.

Paths are under `apps/api/test/` (API), `apps/web/e2e/` (Playwright), `apps/web/test/` (web components), `packages/<name>/test/` and `docs/superpowers/`. The hosted-page website filled in by "Use the Roofline page" is the full privacy URL (Ruling AT), and `texting-submit.test.ts` pins it.

## Sign-up
- **A new user signs up and sees the map home with the Setup window in under 2 minutes (three inputs). No card is needed.**
  - `apps/web/e2e/signup.spec.ts`: "a new roofer reaches the map with Setup open in under 2 minutes, no card".
  - `apps/api/test/signup-company.test.ts`: "sign-up sets the company up from the address"; "sign-up gives the map 2 seconds"; "an address we can't find still creates the account, unlocated"; "Google sign-up asks for the company details too".
  - `apps/api/test/auth-password.test.ts`, `auth-google.test.ts` (sign-up paths).

## Billing, in CI (with the Stripe fake)
- **Trial, then pick plan and card, gives `active`, with the trial end kept**
  - `apps/api/test/stripe-hooks.test.ts`: "trial → plan and card → active, with the trial end kept".
  - `apps/api/test/billing-routes.test.ts`: "checkout keeps the trial end"; "a trial ending within 48 hours bills at checkout"; "a trial ending in exactly 49 hours is kept".
  - `apps/api/test/stripe-events.test.ts`: "maps subscription created with trialing status, plan key and period start".
- **Trial end without a card gives `trial_ended`, read-only, and the send gate blocks with rule `billing`**
  - `apps/api/test/end-trials.test.ts`: "a trial that ran out ends and is audited once"; "a trial with time left and an active company are untouched"; "a second run changes nothing".
  - `apps/api/test/read-only.test.ts`: "reads work, writes are refused with the plain message"; "signing out, billing and today-shown still work"; "the dispatcher blocks a scheduled text once the trial ended".
  - `apps/api/test/read-only-guard.test.ts` (which writes stay open).
  - `packages/send-gate/test/decide.test.ts`: `describe('billing')` (rule `billing`, "Texting is paused until billing is sorted out.").
  - `apps/web/e2e/billing.spec.ts`: "trial ended: banner, read-only message on a save".
  - `apps/web/test/billing.test.tsx`: "trial ended shows the pick-a-plan banner".
- **A payment-failed webhook gives the past-due banner, and rule `billing` blocks**
  - `apps/api/test/stripe-hooks.test.ts`: "a failed payment makes the company past due and the gate blocks texts"; "a paid invoice clears past due, but never revives a canceled company".
  - `apps/api/test/stripe-events.test.ts`: "maps invoice payment_failed to past_due"; "maps invoice paid to active with onlyIfPastDue true".
  - `apps/api/test/read-only.test.ts`: "past due is not read-only".
  - `packages/send-gate/test/decide.test.ts`: "a toll-free number on a past_due company reports billing, not contact".
  - `apps/web/e2e/billing.spec.ts`: "past due: the payment banner".
  - `apps/web/test/billing.test.tsx`: "past due shows the payment banner, with Fix payment for the owner"; "past due tells an office user to ask the owner, with no Fix payment button".
- **Usage rows give meter reports and invoice items with the right amounts**
  - `apps/api/test/report-usage.test.ts`: "usage becomes one meter event per meter and invoice items with the right amounts"; "a second run reports nothing new"; "a crash after reporting resends the same batch, which the provider ignores"; "meter usage waits for a subscription; invoice items do not"; "company B's usage never goes to A's customer".
  - `packages/db/test/usage.test.ts`: "writes once per (kind, refType, refId)".
  - `packages/shared/test/billing.test.ts`: "example config parses and metering math matches the spec".
  - `apps/api/test/stripe-sync.test.ts` (plans, meters and prices created from the config).

## Billing, in the manual smoke suite (Stripe test mode)
- **The same flow on a Stripe test clock, with meter events and invoice items visible in the Stripe dashboard**
  - Manual: `docs/superpowers/f3-manual-smoke.md`, section "(a) Stripe test clock".
  - Automated guard: `apps/api/test/smoke-guards.test.ts` (the smoke scripts refuse a live Stripe key and need an explicit confirmation).

## Import
- **A 1,000-row fixture CSV with messy headers, duplicates and bad phones gives the right new, updated and skipped counts**
  - `apps/api/test/import-run.test.ts`: "the 1,000-row file gives the right new, updated and skipped counts".
  - `apps/api/test/import-plan.test.ts`: "the 1,000-row fixture plans exactly"; "fills names and phones from Excel quirks"; "matches by email when no phone matches, and a phone match beats an email match".
  - `apps/api/test/imports-api.test.ts`: "upload the 1,000-row file: auto-mapped, with exact counts and 20 preview rows".
  - `apps/api/test/import-mapping.test.ts`, `import-parse.test.ts` (messy headers, Excel files).
  - `apps/web/e2e/import.spec.ts`: "import a spreadsheet, with consent, and download the skipped rows" (a 25-row fixture, `apps/web/e2e/fixtures/customers-25.csv`).
- **Attested customers have a full consent record; unchecked imports are `express` only**
  - `apps/api/test/import-run.test.ts`: "attested customers have a full consent record"; "an unchecked import gives express only"; "the audit has the import and the consent confirmation".
  - `apps/api/test/imports-api.test.ts`: "the checked preview shows the consent outcome"; "the consent statement must match".
  - `packages/shared/test/consent.test.ts`.
- **Matched customers who were `revoked`, `written` or `do_not_contact` keep that status**
  - `apps/api/test/import-run.test.ts`: "matched customers who were revoked, written or do-not-contact keep that status".
  - `apps/api/test/import-apply-consent.test.ts`: "import after a committed STOP leaves the customer revoked"; "a chunk waits for an uncommitted STOP and then leaves the customer revoked"; "numbers an import adds to an opted-out customer go on the opt-out list".
- **No jobs are created when no stage column is mapped**
  - `apps/api/test/import-run.test.ts`: "jobs only when a stage column is mapped".
  - `apps/api/test/import-plan.test.ts`: "maps stage words".
- **The skipped-rows CSV is downloadable**
  - `apps/api/test/import-run.test.ts`: "the skipped-rows file lists every skipped row".
  - `apps/api/test/imports-api.test.ts`: "skipped rows only after it finishes".
  - `apps/api/test/skipped-csv.test.ts`: formula cells, quoting, CRLF, the Row and Reason columns.
  - `apps/web/e2e/import.spec.ts`: the download link really downloads the skipped rows.
  - `apps/web/test/import-wizard.test.tsx`: "the preview says why a row will be skipped".
  - Also: `apps/api/test/import-run.test.ts` ("a crash halfway resumes without duplicates"; "running it again does nothing") and `apps/api/test/sweep-imports.test.ts`.

## Texting registration
- **In CI: a recorded fake of Twilio's registration API moves the statuses correctly, rejection shows Fix and resubmit, and the number lands in `company_phone_numbers`**
  - `apps/api/test/texting-recorded.test.ts`: "with Twilio's recorded answers, a registration goes from submitted to approved, and a rejection to Fix and resubmit"; "a brand the carriers reject shows Fix and resubmit with a plain reason".
  - `apps/api/test/texting-progress.test.ts`: "brand approved → campaign submitted with the company's details, fee once"; "campaign approved → a number in the area code, saved as main, texting on"; "a failed campaign shows Fix and resubmit"; "buying the number waits for a working card".
  - `apps/api/test/texting-submit.test.ts`: "submit saves, queues and answers waiting"; "a refused brand needs a fix"; "fix and resubmit sends the previous ids"; "a field error names the brand field".
  - `apps/api/test/texting-callbacks.test.ts`: "a signed callback wakes the registration"; "the poll checks brands hourly and campaigns daily".
  - `apps/api/test/texting-provision.test.ts`, `twilio-accounts.test.ts`, `twilio-brands.test.ts`, `texting-fees.test.ts`.
  - `apps/web/test/texting.test.tsx`: "shows the reason and highlights fields on a rejection"; "shows the number once approved".
  - `apps/web/test/setup.test.tsx`: "a rejected registration offers Fix and resubmit".
- **In manual smoke: one real registration of Roofline's own test brand**
  - Manual: `docs/superpowers/f3-manual-smoke.md`, section "(b) Texting: one real test-brand registration".
- **The hosted privacy and terms pages render with the company's details**
  - `apps/api/test/policy-pages.test.ts`: "privacy on the company host"; "terms carry the texting program terms"; "the path form works on any host"; "company details are escaped"; "an unknown slug is a plain 404 page".
  - `apps/api/test/texting-submit.test.ts`: "the hosted policy pages fill an empty website with the full privacy URL".
  - Manual, on the real domain: `docs/superpowers/f3-manual-smoke.md`, section "(c) Hosted pages render on the real domain".

## Checklist
- **The Setup checklist reflects every item's status; items owned by later specs show "Coming with [feature]" until those ship**
  - `apps/api/test/setup.test.ts`: "a new company starts with nine items, five to do"; "a located company has its basics done"; "skipping the import counts toward progress, and unskip undoes it"; "texting cannot be skipped"; "a pending invite shows the team step as started"; "a pending registration is waiting"; "a rejection lists only real brand fields"; "office can read but not skip; reps can read"; "company B never sees A's checklist".
  - `packages/shared/test/setup.test.ts`: "waiting on carriers, and a rejection with its reason"; "skips only what may be skipped, and done beats skipped".
  - `apps/web/test/setup.test.tsx`: "lists nine steps with their chips"; "later steps say what they come with"; "the owner skips the import and the ring moves"; "the ring hides when setup is done".
  - `apps/web/e2e/setup.spec.ts`: "skip the import and the ring moves"; "later steps say Coming with".

## Phone and accessibility (F3 screens)
- `apps/web/e2e/phone.spec.ts`: "sign-up does not scroll sideways"; "F3 pages do not scroll sideways".
- `apps/web/e2e/a11y.spec.ts`: "sign-up has no serious accessibility violations"; "setup has no serious accessibility violations".

## Gaps and notes
- **No acceptance item is without a test or a manual-smoke section.**
- **Not yet run on CI:** GitHub Actions was down, so the database-backed tests and all Playwright specs above are written and listed, not proven. Run `ops/bin/ci-check` (Platform and E2E jobs) when Actions is back.
- **Manual smoke items:** Stripe test clock, one real test-brand registration, hosted pages on the real domain, Geocodio, Postmark and the TrustHub policy SIDs, all in `docs/superpowers/f3-manual-smoke.md`.
