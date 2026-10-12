# S1 manual smoke runbook

These checks touch real providers with real test credentials: NOAA MRMS data on staging, a Google Ads test account, a Meta test ad account and Postmark. Nothing in CI or the unit suite calls a provider, and nothing here runs from a builder or agent. The owner runs each check by hand, in a terminal on a machine that holds the test credentials, and records the result in the sign-off table at the end.

Rules for every check:

- Never paste a key, token, account id or address into a chat, a ticket or this file. Use the placeholders as written: `<testCustomerId>`, `<testAdAccountId>`, `<your address>` and `<staging host>`.
- Run commands from the repository root unless a line says otherwise.
- The `smoke:storm` script loads the same settings as the API, and no process reads `.env` by itself. From the repository root, run `set -a; . ./.env; set +a` first, with a private `.env` made from `.env.example`. Never create, stage or commit a `.env` file.
- `npm run smoke:storm` is never run by CI or an agent. Never run `smoke:*` in automation.
- The script refuses to run unless `--confirm-real-providers` is passed. Every live step sits behind that flag.
- The script prints no secrets. If something that looks like a secret appears on screen or in a capture, stop and rotate that secret before going on.
- Nothing here changes the code. If a check fails, record the result in the sign-off table and open a separate change.

## (a) Hail worker against real MESH, on staging

**What it proves:** a real NOAA MRMS `MESH_Max_1440min_00.50` file is fetched, contoured and written by the staging hail worker, and the contours match NOAA's own viewer for the same valid time.

> **Open item for the lead: the `--once` flag does not exist yet.** `services/hail/hail/main.py` has no `--once` flag today. It only runs the :05 and :35 loop. Report this to the S1 lead before running this check. Until a ruling adds the flag, the only supported way to get one cycle is to let the worker run at the next :05 or :35 and read the `hail_runs` row it writes. Do not call the module from `python -c`; that is not supported.

**Needs:**

- The staging hail worker environment, with `HAIL_DATABASE_URL` for the `app_hail` login, set as described in `services/hail/README.md` under "Render setup".
- A staging shell with the GDAL image tooling (`ghcr.io/osgeo/gdal:ubuntu-small-3.8.5`).
- A read-only query tool for the staging database, to read `hail_runs`.

**Commands, in order:**

1. On `<staging host>`, open a shell in the staging checkout and run `cd services/hail`.
2. Run `python -m hail.main --once` (only after the open item above is resolved).
3. With the read-only query tool, read the newest `hail_runs` row. Note its status and its `valid_at` time.
4. Open https://mrms.ncep.noaa.gov/ in a browser, select the MESH 1440 min layer, and set the valid time to the `valid_at` time from step 3.

**Expected result:**

- A new `hail_runs` row with status `ok` and a `valid_at` time.
- In NOAA's viewer, for the same valid time, the same cells show hail at the 0.75 in, 1 in and 2 in levels that the app's contours show.
- Write the valid time you compared in the sign-off table.

CI runs the Python tests (`ruff` and `pytest`) in the `hail` job. Prove that with `CI_JOBS="Platform Hail" ops/bin/ci-check`. Never run the Python tests locally; the build box cannot run them.

## (b) Google Ads test account

**What it proves:** the link status, the account info and one **paused** campaign in a Google Ads **test** account, all through the real Google Ads API.

**Needs:**

- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_MANAGER_ID`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET` and `GOOGLE_ADS_REFRESH_TOKEN` in the shell. `GOOGLE_ADS_API_VERSION` is optional.
- A Google Ads test account `<testCustomerId>` under the test manager account.

**Refusal rule:** the script refuses unless the account is a Google Ads test account. The only exception is `--i-understand-spend`. It allows exactly one paused campaign with a $1 daily budget (100 cents, `SMOKE_BUDGET_CENTS`), and that campaign must be removed at once. On a non-test account the script removes the campaign itself, even when the pause check fails; it prints REMOVE THE CAMPAIGN BY HAND only when its own removal fails. Use `--i-understand-spend` only on a real account that the owner accepts a $1 risk on.

**Commands, in order:**

1. `npm run smoke:storm -w @roofline/api -- --confirm-real-providers --google <testCustomerId>`
2. Only for a real account that the owner accepts the $1 risk on: add `--i-understand-spend` to the same command, the script removes the campaign itself; remove it by hand only if the script says so.

**Expected result:**

- The link status is printed.
- The account name and currency are printed.
- The script prints "created paused", and then the status paused is verified.
- On a non-test account the script prints Removed the Google test campaign.
- A scrubbed capture block is printed.
- If the script says the removal must be done by hand, remove the campaign in the Google Ads UI before continuing, and note that in the sign-off table.

## (c) Meta test ad account

**What it proves:** the access check, the card image upload and one **paused** campaign that is deleted again, all against a Meta test ad account.

**Needs:**

- `META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN` and `META_BUSINESS_ID` in the shell. `META_GRAPH_VERSION` is optional.
- A Meta test ad account `<testAdAccountId>` that is shared with the business.

**Command:** `npm run smoke:storm -w @roofline/api -- --confirm-real-providers --meta <testAdAccountId>`

**Expected result:**

- The access check prints `ok` with the account name and currency. If it prints `not_shared`, `not_assigned` or `disabled`, the script stops. Fix the sharing or the assignment in Business Manager, then run the check again.
- The card image uploads. The script renders a real ad card (a 1080 x 1080 PNG with the smoke company name and line) with the same renderer the app uses, and uploads that.
- The script prints "created paused", and then "deleted".
- If the script prints "DELETE THE CAMPAIGN BY HAND", delete that campaign in Ads Manager before continuing, and note it in the sign-off table.

## (d) Broadcast email with a working unsubscribe

**What it proves:** one email goes out over Postmark's broadcast stream, carries a one-click unsubscribe, and the unsubscribe link opens the right page.

**Needs:**

- `POSTMARK_TOKEN`, `MAIL_FROM` (or `STORM_MAIL_FROM`), `POSTMARK_BROADCAST_STREAM` (the default is `broadcast`), `APP_ORIGIN` and `ENCRYPTION_KEY` in the shell.
- `<your address>`, a real address that you can read.

**Command:** `npm run smoke:storm -w @roofline/api -- --confirm-real-providers --email <your address>`

**Expected result:**

- The script prints `sent`.
- The email arrives in your inbox.
- In the message headers (Show original), `List-Unsubscribe` and `List-Unsubscribe-Post` are both present.
- The unsubscribe link in the body starts with the `APP_ORIGIN` value followed by `/u/`.
- Open the link and check that it loads. The smoke link signs a fixed smoke company id, so against a real server the page shows the unsubscribe form or a confirmation for that fake company, and it records nothing real. Submit the form only if you need to see the confirmation. Write in the sign-off table what you actually see.

**All three in one command:** checks (b), (c) and (d) can be run together by passing the flags in one command:

`npm run smoke:storm -w @roofline/api -- --confirm-real-providers --google <testCustomerId> --meta <testAdAccountId> --email <your address>`

Add `--i-understand-spend` only when check (b) needs it. The first time through, run the checks one at a time, so that a failure is easy to read.

## After the runs

- The scrubbed capture block that the script prints replaces the Task 17 and Task 18 fixtures. Copy it by hand into the fixture files after reading every value in it. Do not paste the block in as it is.
- Never commit anything with an id, token or address. Check the staged diff (`git diff --cached`) before any commit.
- Delete any local capture you saved after copying the scrubbed fields from it.
- Never run `smoke:*` in automation.

## Sign-off

Record each check once it has been run. Use the result column for a short plain sentence, such as "Passed; both pages load" or "Blocked; the flag does not exist yet". Do not put any key, token, account id or address in this table.

| Date | Who | Check | Result |
| --- | --- | --- | --- |
|  |  | (a) Hail worker on staging, and the NOAA viewer comparison (record the valid time) |  |
|  |  | (b) Google Ads test account |  |
|  |  | (c) Meta test ad account |  |
|  |  | (d) Broadcast email |  |
|  |  | (d) Unsubscribe link |  |
