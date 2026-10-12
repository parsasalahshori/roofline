# E1 manual smoke runbook

These checks touch real providers with real test credentials: EagleView (sandbox), Cloudflare R2, and a real proposal text to a test phone on staging. Nothing in CI or the unit suite calls a provider, and nothing here runs from a builder or an agent. Running the smoke script needs the owner's EagleView sandbox credentials, the owner's R2 credentials and a test phone. It must never run in automation (a scheduled job, a CI workflow, a Routine or an agent session). The owner runs each check by hand, in a terminal on a machine that holds the test credentials, and records the result in the sign-off table at the end.

The script lives at `apps/api/src/scripts/smoke/estimator.ts`. Its guards live at `apps/api/src/scripts/smoke/estimator-guards.ts`. The guards refuse a run before any provider is called, so a mistyped command costs nothing.

Rules for every check:

- Every command needs `--confirm-real-providers`. Without it the script refuses to start.
- Run commands from the repository root. Load the settings first with `set -a; . ./.env; set +a`. For check (c), load the staging values from a private env file kept outside the repository, the same way. Never commit that file.
- Never paste a key, a token, a client secret, a phone number or a proposal link into a chat, a ticket or this file. The script hides secrets in its own output, but check its output before you share it.
- Never use production EagleView. The script refuses `EAGLEVIEW_ENV=production`, and it refuses `--place-order` unless `EAGLEVIEW_ENV=sandbox`.
- If a command prints something that looks like a secret, stop and rotate that secret before doing anything else.
- The script exits with code 1 when any check fails. Each check prints one `PASS` or `FAIL` line.
- The script prints a plain sentence for a failure. It never prints a provider's own error text. For the cause, check the status codes in the provider's dashboard (see "If something fails" below).
- Missing settings are named by key only (for example, `Set these first: EAGLEVIEW_CLIENT_SECRET.`). The values are never printed.

## (a) EagleView sandbox: token, property data and a price

**What it proves:** Roofline can get an EagleView token, ask the sandbox for aerial property data on a documented Omaha test address, and get a sandbox price for a report order. The sandbox never charges. The first request also fetches the token, so the property data line covers the token too.

**Needs:**

- `EAGLEVIEW_CLIENT_ID` and `EAGLEVIEW_CLIENT_SECRET`: the owner's EagleView sandbox credentials.
- `EAGLEVIEW_PRODUCT_ID`: a positive whole number from EagleView onboarding (the Premium Residential product id). The script refuses a missing value, a value of 0 and anything that is not a number.
- `EAGLEVIEW_ENV=sandbox`.

**Commands, in order:**

1. `npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox`

**Expected result:**

- `PASS eagleview property data: <n> roof(s); first roof <area> sq ft, pitch <x>/12`. The roof count is 1 or more, the area is in square feet, and the pitch is shown as a number out of 12 (for example, 7/12).
- `PASS eagleview price (sandbox, not charged): $<dollars>.<cents>, quote valid until <time>`. The price is in dollars and the time is the quote's expiry. The quote expires after a short window, so note the time and do not hold the quote.
- `SKIP place order (pass --place-order, sandbox only)`. This is correct for the command above.
- The run exits with code 0.

If the property data line says EagleView was not ready after 10 tries, run the check again once. Two failures in a row mean the sandbox is not answering; check the status codes in the EagleView dashboard.

### (a2) Optional: place a sandbox order (PlaceOrder)

**What it proves:** the sandbox accepts a real PlaceOrder call and returns a report reference. In the sandbox this is not charged. The script refuses this step unless `EAGLEVIEW_ENV=sandbox`, and it only runs with `--eagleview-sandbox` in the same command.

**Needs:** everything in (a), with `EAGLEVIEW_ENV=sandbox` set in the shell (not `production`, and not left blank).

**Commands, in order:**

1. `npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox --place-order`

**Expected result:**

- The same three lines as in (a), with the place order line in place of the SKIP line: `PASS eagleview place order (sandbox): reference <reference id>`.
- The reference id is a sandbox id. It is not a real report. Do not order a real report with it.
- The sandbox charges nothing. If the EagleView sandbox dashboard shows a charge, stop and report it to the owner before the next run.

If the shell has `EAGLEVIEW_ENV=production`, the script refuses the whole run with `The smoke run only uses the EagleView sandbox.` Fix the variable and run again.

## (b) R2: put, get, delete one test object

**What it proves:** Roofline can write, read back and delete one test object in the R2 bucket, and the delete is confirmed by a second read that finds nothing.

**Needs:**

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET`: the owner's R2 credentials and a test bucket. Do not use the production bucket.

**Commands, in order:**

1. `npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --r2`
2. Open the Cloudflare dashboard for the test bucket and look under the `smoke/` prefix. The object named `smoke/estimator-<timestamp>.txt` from this run must not be there.

**Expected result:**

- `PASS r2 put`
- `PASS r2 get` (the bytes read back match the bytes written)
- `PASS r2 delete`
- `PASS r2 get after delete` (the object is gone)
- The dashboard shows no `smoke/estimator-<timestamp>.txt` object from this run.
- The run exits with code 0.

If `r2 put` fails, the script skips the other three lines and prints `SKIP r2 get, r2 delete and r2 get after delete`. Nothing was stored, so there is nothing to remove. If a later step fails after the put, a test object may be left under `smoke/`. Delete it by hand in the dashboard. It holds only the test sentence.

## (c) A real proposal text to the owner's test phone (staging only)

**What it proves:** the real send path works on staging end to end. A draft proposal is approved as the owner, the send step runs through the worker's own step runner, the messaging send gate allows it, and Twilio sends a real text. The text has the company name, the address and a proposal link. Opening the link shows the homeowner proposal page with the Estimate labels. The proposal then shows as sent in the app.

This check sends a real text to a real phone. It runs only on staging, never against production data, and only to a phone that belongs to the owner.

**Needs:**

- A staging deployment. Never production data.
- `DATABASE_URL_TENANT` and `DATABASE_URL_SYSTEM` for staging, `ENCRYPTION_KEY`, `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`, and every other key the staging API needs, as deployed. The texting brand and campaign must already be approved (see the F3 manual smoke, check (b)).
- `SMOKE_COMPANY_ID`: the staging company's id (a UUID).
- `SMOKE_OWNER_USER_ID`: the id (a UUID) of the staging owner user who approves the send. The script needs it, even though the guard list does not name it.
- `SMOKE_PROPOSAL_ID`: a proposal (a UUID) in a draft state, in the staging app, for the Omaha test address. Its customer must have the owner's own test phone as the phone number, and that customer must have given texting consent. The script refuses a run when the customer's phone is not the `--sms` number, and then nothing is sent.
- The owner's test phone in E.164 form (a plus sign, then the country code and the number, with no spaces). Type the real number in your own terminal. Do not type it into a ticket, a chat or this file.

**Commands, in order:**

1. Confirm in the staging app that the proposal is a draft, that its customer is the owner's test contact, and that the customer's texting consent is on. Do not send it from the app; the script does the send.
2. `npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --sms +1XXXXXXXXXX`

   Replace `+1XXXXXXXXXX` with the test phone, typed locally. The placeholder above is refused by the guard, which is correct.

3. Read the phone, the staging app and the proposal link (see the expected result). Do not open the link from a shared machine.

**Expected result:**

- `PASS sms handed to the send path (to +1402***0123)`. The phone number is shown masked: the first five characters, `***`, and the last four.
- The owner's phone receives one text. It names the company, gives the address, and has a proposal link. The text ends with `Reply STOP to opt out.`
- Opening the link shows the proposal page, and the page uses the Estimate labels for every instant number and every price derived from one.
- In the staging app, the proposal shows as sent, and its job has moved on.
- The run exits with code 0.

**Run it once.** The script sends at most one text per run. A second run on the same proposal does not send a second text. The send is protected by the dedupe key `proposal:<proposal id>`. The second run prints `FAIL sms handed to the send path (to ...): This proposal was sent. Make a revised proposal to change it.` That line is the expected result for a second run: nothing new was sent, and the proposal is no longer a draft. Do not make a second run to "confirm" the text.

**Combined example:** the three checks can run in one command, with the same confirmation flag. Run this only after (a), (b) and (c) have each been checked separately, because a failure in one check does not stop the others.

`npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox --r2 --sms +1XXXXXXXXXX`

Add `--place-order` only when you also want (a2) in the same run. Replace `+1XXXXXXXXXX` with the test phone, typed locally.

## (d) Footprints for one real state on staging (Nebraska)

**What it proves:** the footprint loader can load one real state from the open building data into staging. It loads the Microsoft building footprints for Nebraska (state code `NE`), and a point inside the Omaha test address finds a footprint. This is a staging operation. It is not part of the smoke script, and no command in the script loads footprints.

**How the loader starts (no manual command):** there is no command to type. The footprint load is started by the platform itself:

- The scheduler runs `footprints-ensure` every 15 minutes (`*/15 * * * *`, in `apps/api/src/jobs/worker.ts`). For each state where a company's address state is not yet ready and not already loading, it queues one `footprints-load` job, keyed by the state.
- Measuring a property in a state that is not loaded also queues the same `footprints-load` job (`apps/api/src/estimator/measure.ts`).

So for Nebraska, the staging company's address state must be `NE` (the Omaha test address is in Nebraska), and the staging worker process must be running. Then the load starts at the next 15-minute tick. To start it sooner, open a measurement at an address in Nebraska in the staging app. The worker must also reach the footprint source (the `FOOTPRINTS_BASE_URL` setting, which defaults to Microsoft's open data), so check that staging's network allows it.

**Needs:**

- A staging deployment with the worker running, and `FOOTPRINTS_BASE_URL` reachable from staging (the default is Microsoft's open data).
- The staging company's address state is `NE`.
- A psql session on the staging database, for the read-only queries below. Use the owner's own staging connection. Never run these on production.

**Record before the load starts:**

1. `select pg_size_pretty(pg_database_size(current_database()));` (database size before)
2. `select pg_size_pretty(pg_total_relation_size('building_footprints'));` (table size before)
3. `select count(*) from building_footprints where state = 'NE';` (rows before, expected 0)
4. Note the time the load starts. The first place it shows is `building_footprint_states` (the `started_at` column), once the job claims the state.

**Commands and queries, in order:**

1. Start the load: make sure the staging company's address state is `NE`, then wait for the next 15-minute tick or open a measurement at a Nebraska address in the staging app.
2. Watch the state row until its status is `ready` or `failed`:
   `select state, status, buildings, started_at, loaded_at, error_plain from building_footprint_states where state = 'NE';`
3. Count the rows loaded: `select count(*) from building_footprints where state = 'NE';`
4. Look for one footprint at the Omaha test address. Use the coordinates the staging app geocodes for that address. Approximate coordinates for downtown Omaha are longitude -95.9345 and latitude 41.2565; confirm them against the geocoder result before you trust the answer. Note that `ST_MakePoint` takes longitude first:
   `select id, area_sq_ft from building_footprints where state = 'NE' and ST_Intersects(geom, ST_SetSRID(ST_MakePoint(-95.9345, 41.2565), 4326)) limit 3;`
5. Record after the load:
   - `select pg_size_pretty(pg_database_size(current_database()));` (database size after)
   - `select pg_size_pretty(pg_total_relation_size('building_footprints'));` (table size after)

**Elapsed time:** from `building_footprint_states` for `NE`, elapsed minutes = `loaded_at` minus `started_at`. Write it as minutes with one decimal place.

**Expected result:**

- `building_footprint_states` shows `NE` with status `ready`, a `buildings` count that matches the count in step 3, and an empty `error_plain`.
- The load finishes without error. The state is not stuck in `loading`. If it is still `loading` long after `started_at` and no tick has passed, check the worker logs for `footprints-load`.
- The point query in step 4 returns at least one footprint, with a positive `area_sq_ft`.
- The table size after the load is recorded, and so is the elapsed time.

If the state shows `failed`, `error_plain` holds the loader's own plain sentence. Remove nothing by hand. Fix the cause (usually the network to the footprint source) and start the load again. A failed load deletes its partial rows, so the state starts clean.

## If something fails

- A `FAIL` line with a plain sentence is the script's own message. It is safe to share, because it contains no provider text.
- For EagleView, look up the status code in the EagleView sandbox dashboard. The script shows only a plain sentence, such as `The check could not finish.`, so the status code is the way to find the cause.
- For R2, a delete that is refused prints the status code, for example `R2 refused the delete (status 403).` Check that the test credentials allow deletes in the test bucket.
- For the text, `FAIL sms handed to the send path` gives a plain reason, such as a missing texting consent or a send gate block. Fix the cause in the staging app, then do not re-run the text until the proposal is a draft again.
- A `Set these first: ...` line names the missing keys. Set them in the shell and run again. The values are never printed.
- A `Set ... to staging UUIDs first.` line means `SMOKE_COMPANY_ID`, `SMOKE_PROPOSAL_ID` or `SMOKE_OWNER_USER_ID` is missing or is not a UUID.
- If the output of any command shows a value that looks like a secret, stop and rotate that secret.

## (e) Sign-off

Record each check once it has been run. Use the result column for a short plain sentence, such as "Passed; three PASS lines" or "Failed; R2 refused the delete (status 403), fixed and passed on rerun". Use `pass` or `fail` in the result column. Do not put any key, token, phone number, link or brand value in this table.

| Check | Command | Date | Result (pass/fail) | Time | Size | Who | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (a) EagleView sandbox | `smoke:estimator --confirm-real-providers --eagleview-sandbox` |  |  |  |  |  |  |
| (a2) PlaceOrder sandbox (optional) | `smoke:estimator ... --eagleview-sandbox --place-order` |  |  |  |  |  |  |
| (b) R2 put, get, delete | `smoke:estimator ... --r2` |  |  |  |  |  |  |
| (c) A real proposal text (staging) | `smoke:estimator ... --sms +1XXXXXXXXXX` |  |  |  |  |  |  |
| (d) Footprints load, NE (staging) | No command: scheduler tick or a measurement |  |  | Elapsed minutes: | Table size before and after: |  |  |
