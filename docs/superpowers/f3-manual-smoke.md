# F3 manual smoke runbook

These checks touch real providers with real test credentials. Nothing in CI or the unit suite calls a provider, and nothing here runs from a builder or agent. The owner runs each check by hand, in a terminal on a machine that holds the test credentials, and records the result in the sign-off table at the end.

Rules for every check:

- Never paste a key, token or brand detail into a chat, a ticket or this file.
- Run commands from the repository root unless a line says otherwise.
- The npm scripts in checks (a) and (b) load the same settings as the API, and no process reads `.env` by itself. In the terminal, from the repository root, run `set -a; . ./.env; set +a` first, with a `.env` made from `.env.example` (so `NODE_ENV`, `APP_ORIGIN`, `PUBLIC_BASE_URL`, `DATABASE_URL_TENANT`, `DATABASE_URL_SYSTEM` and `ENCRYPTION_KEY` are set). No database needs to be running.
- If a command prints something that looks like a secret, stop and rotate that secret.

## (a) Stripe test clock

**What it proves:** a starter customer on a Stripe test clock gets two metered usage events, one invoice item, and the starter tiers applied, all in Stripe's test dashboard.

**Needs:**

- `STRIPE_SECRET_KEY`: a test secret key that starts with `sk_test_`. The script refuses any other key.
- `STRIPE_WEBHOOK_SECRET`: required whenever `STRIPE_SECRET_KEY` is set. Any value that starts with `whsec_` works; the smoke does not check webhooks.
- `BILLING_PLANS_FILE` (optional): the billing plan file the sync reads. Outside production it defaults to `config/billing-plans.example.json`.

**Commands, in order:**

1. `npm run sync:stripe-plans -w @roofline/api` (makes Stripe match the plan file; run it first).
2. `npm run smoke:stripe -w @roofline/api`

**Expected result:**

- The sync prints one line per change and exits without error.
- The smoke run prints dashboard links that start with `https://dashboard.stripe.com/test/`. It never prints the key.
- In the Stripe test dashboard, the test clock's invoice shows:
  - a meter event for `roofline_sms_segment` with value 6;
  - a meter event for `roofline_ai_call_minute` with value 4;
  - an invoice item "Exact roof report — 812 Oak St (smoke)" of $54.00.
- The starter tiers are applied: the metered lines are at $0 because the usage sits inside the included amounts.

## (b) Texting: one real test-brand registration

**What it proves:** Roofline's own brand, registered once as a real test brand with the phone carriers, moves to approved. This costs money and takes days. It is run once, on purpose.

**Needs:**

- `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`: the master Twilio credentials for the test account.
- `TWILIO_PRIMARY_PROFILE_SID`: the primary business profile sid.
- `SMOKE_BRAND_JSON`: Roofline's own brand details, as one JSON object with these fields: `legalName`, `ein`, `businessType`, `street`, `city`, `state`, `zip`, `website`, `contactFirstName`, `contactLastName`, `contactTitle`, `contactEmail`, `contactPhone`. The values are not written in this file. Keep the JSON in a private file or a password manager and load it into the shell only for the run.
- The optional `--state <path>` flag. The default state file is `.smoke-texting.json`. It is git-ignored because it holds a subaccount token. Keep it private and delete it when the smoke is finished.

**Commands, in order:**

1. Submit the subaccount and the brand (this makes the real registration):
   `npm run smoke:texting -w @roofline/api -- --submit --confirm-real-registration`
2. Check the status. Run this again every day or two until the brand is approved:
   `npm run smoke:texting -w @roofline/api -- --status`
3. Only once the brand is approved, create the campaign. The URLs are the hosted policy pages from check (c):
   `npm run smoke:texting -w @roofline/api -- --campaign --confirm-real-registration --privacy-url https://<slug>.<POLICY_PAGES_DOMAIN>/privacy --terms-url https://<slug>.<POLICY_PAGES_DOMAIN>/terms`

Replace `<slug>` and `<POLICY_PAGES_DOMAIN>` with the real values. Do not commit them.

**Expected result:**

- `--submit` prints that the subaccount and the brand were sent. It never prints a token. It refuses to run without `--confirm-real-registration`.
- `--status` prints the brand status and the campaign status in plain words. Right after submission the brand says it is pending. Expect days, not hours. The brand moves to approved in a later check.
- `--campaign` is refused until the brand is approved. Once approved, it prints that the campaign was sent.

## (c) Hosted pages render on the real domain

**Needs:** the company slug and `POLICY_PAGES_DOMAIN`, as deployed.

**Command:** open these two addresses in a browser, or run `curl -sS -o /dev/null -w "%{http_code}\n" <url>` for each:

- `https://<slug>.<POLICY_PAGES_DOMAIN>/privacy`
- `https://<slug>.<POLICY_PAGES_DOMAIN>/terms`

**Expected result:** both pages load over HTTPS with a normal page (status 200), show the company's name, and have no error text. The curl check should print `200` for each.

## (d) Geocodio answers for one known address

**Needs:** `GEOCODIO_API_KEY` in the shell.

**Command** (run from `apps/api`; the one-liner prints only the coordinates, never the key):

```
cd apps/api && npx tsx -e "import('./src/providers/geocodio.ts').then(async ({ GeocodioGeocoder }) => { const g = new GeocodioGeocoder({ apiKey: process.env.GEOCODIO_API_KEY ?? '' }); const r = await g.geocode('1600 Pennsylvania Ave NW, Washington, DC 20500').catch(() => 'unavailable'); console.log(typeof r === 'string' ? r : r ? `lat ${r.lat}, lng ${r.lng}, accuracy ${r.accuracyType}` : 'no match'); })"
```

**Expected result:** one line that starts with `lat` and gives a latitude near 38.90 and a longitude near -77.04, with an accuracy type such as `rooftop`. A line that says `unavailable` means the key or the network failed; check the key and try again.

**Version check (Ruling 31):** open Geocodio's current API documentation and compare it with the version in `apps/api/src/providers/geocodio.ts` (the `DEFAULT_BASE_URL` line, which is `v1.7` at the time of writing). Expected: the code's version is the current one. If the docs show a newer version, write the new version in the change log of this runbook and open a separate change; do not change the version as part of this check.

## (e) Postmark delivers a test email

**Needs:** `POSTMARK_TOKEN` and `MAIL_FROM` set for the running app, and a real address you can read.

**Steps:**

1. Start the app as usual (`npm run dev -w @roofline/api` and the web app).
2. On the sign-in page, use the reset-password link. Enter your real address.
3. Check your inbox and spam folder.

**Expected result:** within a few minutes the email "Reset your Roofline password" arrives from the verified From address. The link in the email opens the reset page. The sign-in page shows the same neutral message for any address, so a missing email is a sign that Postmark did not deliver; check the Postmark activity log for the sender.

## (f) TrustHub policy SIDs match Twilio's ISV guide

**What it proves:** the two policy sids in `apps/api/src/providers/twilio/brands.ts` (re-exported from `brand-profile.ts`) are the ones Twilio's ISV guide lists. The constants are `SECONDARY_PROFILE_POLICY` and `A2P_PROFILE_POLICY`. The first has a note in the code that asks for this check.

**Steps:**

1. Open Twilio's ISV guide for the Trust Hub policies (the Secondary Customer Profile and the A2P Messaging profile policies).
2. Compare each policy sid in the guide with the constant of the same name in `brands.ts`.

**Expected result:** both sids match the guide exactly. If either differs, do not run check (b) `--submit`. Fix the constant in a separate change, then rerun this check.

When this check passes, remove the "confirm against Twilio's ISV guide" note from the line in `brand-profile.ts` in the same change.

## (g) Sign-off

Record each check once it has been run. Use the result column for a short plain sentence, such as "Passed; both pages load" or "Pending; submitted, waiting on carriers". Do not put any key, token or brand value in this table.

| Date | Who | Check | Result |
| --- | --- | --- | --- |
|  |  | (a) Stripe test clock |  |
|  |  | (b) Texting: submit the brand |  |
|  |  | (b) Texting: status (repeat until approved) |  |
|  |  | (b) Texting: create the campaign |  |
|  |  | (c) Hosted pages on the real domain |  |
|  |  | (d) Geocodio answers for one address, and the version check |  |
|  |  | (e) Postmark delivers the reset email |  |
|  |  | (f) TrustHub policy sids match the ISV guide |  |
