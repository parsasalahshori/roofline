### Task 36: End-to-end tests, the acceptance map and the docs

**Base:** `f3-setup` after Tasks 13–35 are merged and `f2-shell` with F2 **T13** (the e2e stack) and F2 **T18** is merged in. From F2 T13 (`apps/web/e2e/`): `stack.ts` (spawns the API and worker with one `env` object; `WEATHER_DISABLED: '1'`), `fixtures.ts` (`readStack`, `getPools`, `resetScenario` → `seedTwoCompanies` + `seedShowcase` for Acme, `test` with `scenario`, `loginAs(page, 'owner'|'office'|'rep')`, `db`, `clicks`/`click`, `markTodaySeen`; `expect`), `playwright.config.ts` (projects `desktop` 1440×900 and `phone` 375×812 matching `/phone\.spec/`), the CI `E2E` job; Chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader`; local browsers at `/opt/pw-browsers` (never `playwright install` locally). From T9: `FAKE_PROVIDERS` (fakes for Geocodio, Stripe, Twilio sending and registration; refused in production).
**Specs that may not exist yet (proposed Ruling AK):** F2 T17 shipped without `phone.spec.ts`, `a11y.spec.ts` and `f2-acceptance.md` (controller scope cut). Whichever F2 task the controller assigns them to (suggest F2 T18 or a new F2 T19) runs before this one; if `apps/web/e2e/phone.spec.ts` / `a11y.spec.ts` still do not exist when this task starts, create them with only the F3 checks below and say so in the report.
**No Docker locally:** every spec here runs only on CI (E2E job). Locally: typecheck, lint, `npx playwright test --list -c apps/web/playwright.config.ts`.

**Split:**
- Builder 1: `stack.ts`/`fixtures.ts` changes, `signup.spec.ts`, `setup.spec.ts`.
- Builder 2: `import.spec.ts`, `billing.spec.ts`, `fixtures/customers-25.csv`, and the `phone.spec.ts`/`a11y.spec.ts` additions.
- Builder 3: `docs/superpowers/f3-acceptance.md`, `docs/superpowers/f1-followups.md`, `README.md` "Running in production".

**Files:**
- Create: `apps/web/e2e/{signup,setup,import,billing}.spec.ts`, `apps/web/e2e/fixtures/customers-25.csv`, `docs/superpowers/f3-acceptance.md`
- Modify: `apps/web/e2e/stack.ts` (`FAKE_PROVIDERS: '1'` in the shared `env`), `apps/web/e2e/fixtures.ts` (`setCompanyStatus`), `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts` (see Ruling AK), `docs/superpowers/f1-followups.md`, `README.md`
- Do not touch: `apps/web/src/**` and `apps/api/src/**` unless a spec exposes a real defect (the lead fixes it, smallest change, listed in the report).

**Interfaces:**
- **`customers-25.csv`:** header `Name,Phone,Email,Address,City,State,Zip`; 25 data rows: rows 1–20 valid and unique (`(402) 555-2001`…`2020`, `<n> Pine St, Omaha, NE 68102`), rows 21–23 bad phones (`555-0144`, `12`, `call me`, no email), rows 24–25 repeat the phones of rows 1–2 → new 20, updated 0, skipped 5.
- **`setCompanyStatus(status: CompanyStatus)`** (exported from `fixtures.ts`, uses the `db` client or a fresh `pg.Client` on `ownerUrl`): `update companies set status = $1 where slug = 'acme-roofing'`.

**Tests:**
- **`signup.spec.ts`** — `test('a new roofer reaches the map with Setup open in under 2 minutes, no card')`:
  1. `const start = Date.now()`; `goto('/sign-up')` (no login).
  2. Fill "Your name", "Email" (`signup-${Date.now()}@example.test`), "Password" (12+ chars); click "Continue".
  3. The company step has exactly 3 textboxes; fill "Acme Test Roofing", "(402) 555-0177", "1200 Farnam St, Omaha, NE 68102"; click "Start my free trial".
  4. `toHaveURL(/\/settings\/setup$/)`; the dialog "Settings"; the row "Your company on the map" contains "Done".
  5. `expect(Date.now() - start).toBeLessThan(120_000)`; `getByText(/card number/i)` has count 0.
- **`setup.spec.ts`** (owner, `markTodaySeen`): `test('skip the import and the ring moves')` — the ring's label "N of 5 setup steps done" increases by one after "Skip for now" on "Bring in your customers"; `test('later steps say Coming with')` — the four "Coming with …" lines.
- **`import.spec.ts`** — `test('import a spreadsheet, with consent, and download the skipped rows')`: owner → `/settings/setup/import`; `setInputFiles` on the file input (by its label "Customer spreadsheet") with `e2e/fixtures/customers-25.csv`; through mapping; the preview shows "20 new customers" and "5 will be skipped"; check the consent box; "Import"; the summary appears within 30 s; `const download = await Promise.all([page.waitForEvent('download'), click('Download skipped rows')])` → `suggestedFilename() === 'skipped-rows.csv'` and the file has 6 non-empty lines.
- **`billing.spec.ts`:** `test('trial ended: banner, read-only message on a save')` — `setCompanyStatus('trial_ended')`, reload → button "Pick a plan to keep going"; change the company phone in Settings → Company and Save → a toast with "Your free trial has ended, so Roofline is read-only for now. Pick a plan to keep going."; `test('past due: the payment banner')` — "Your payment didn't go through. Texts and calls are paused until it's fixed." and "Fix payment".
- **`phone.spec.ts`** (phone project): `/sign-up`, `/settings/setup`, `/settings/billing`, `/settings/setup/import` → `document.documentElement.scrollWidth <= 375` (logged in except `/sign-up`).
- **`a11y.spec.ts`** (desktop): `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa'])` on `/sign-up` and `/settings/setup` → no `serious` or `critical` violations.

**Docs:**
- **`f3-acceptance.md`:** map every bullet of spec §5.6 (`docs/superpowers/specs/2026-10-10-roofline-foundation-design.md`) to its test (file + test name), in the format of `docs/superpowers/f1-acceptance.md`; the manual bullets point at T37's `docs/superpowers/f3-manual-smoke.md`.
- **`f1-followups.md`:** move each item of "Must be done before texting goes live (F3 blockers)" to a "Done in F3" list with its task number.
- **README "Running in production"** (append; keep the env table from T9): boot order adds `npm run sync:stripe-plans -w @roofline/api` before the first deploy and after every price change; the Stripe webhook endpoint `/hooks/stripe` with its five events (`customer.subscription.created`, `.updated`, `.deleted`, `invoice.paid`, `invoice.payment_failed`); the Twilio registration callback `/hooks/twilio-registration`; wildcard DNS `*.<POLICY_PAGES_DOMAIN>` → the API service; owner to-dos: keep Twilio Advanced Opt-Out on with its default keywords, the lawyer reviews the policy templates and the consent sentence, set the real `BILLING_PLANS_FILE`, set `TWILIO_PRIMARY_PROFILE_SID`.

**Verify notes:**
- Locally: `npm run typecheck && npm run lint && npx playwright test --list -c apps/web/playwright.config.ts` (lists the new specs, no errors). Never `npm run e2e` or `playwright install` here.
- CI: `ops/bin/ci-check` with `CI_JOBS="Platform E2E"`; the E2E job must also run the `phone` project (F2 T17's follow-up adds it; if it still runs `--project desktop` only, add `--project phone` to the job's command in `.github/workflows/ci.yml` and say so). v1 must stay green.
- Commit: `test(e2e): sign-up under 2 minutes, setup, import and billing banners; F3 acceptance map`.
