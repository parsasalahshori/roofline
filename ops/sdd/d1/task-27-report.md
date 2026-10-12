# Task 27 report (branch d1-t27)

CI: run 38274122186 on ac2917e, Platform, E2E and v1 all success.

## Added
- `apps/web/e2e/front-desk.spec.ts` (10 tests): empty inbox; inbox list/filters/live/unread/urgent; call view (disclosure, transcript, action card, summary, marked read); dock badge drops on open; staff text reply through the gate (fake SMS adapter, row `sent`) + Team is handling; Mark as spam blocks number; rep isolation; Settings save/limits; transfer phone with recording ack; forwarding guide codes + forwarding test verified (signed Twilio webhook) + enabling Front Desk.
- Seed: no seed path existed, so `apps/web/e2e/front-desk-seed.ts` (e2e only) writes conversations/calls/turns through the tenant pool, adds a Roofline number + signing token, and picks a daytime company time zone so quiet hours never hold the reply. `stack.ts` now sets `TWILIO_TEST_CALLER_NUMBER` and writes `encryptionKey`/`testCallerNumber` to `.stack.json` (`fixtures.ts` Stack type). No `seedFrontDeskFixture` in `apps/api/src/index.ts` (smallest-seed instruction).
- a11y.spec.ts (5 tests) and phone.spec.ts (1 test) appended.
- `docs/superpowers/d1-acceptance.md`, `d1-manual-smoke.md` (M0-M14).
- `apps/api/src/scripts/smoke/front-desk.ts` (`--preflight`, `--llm [--record dir]`, both need `--confirm-real-providers`), `assertConfirmed` widened in `guards.ts`, `smoke:front-desk` script, `apps/api/test/smoke-front-desk-guards.test.ts` (also asserts no workflow runs a smoke).
- Not done: README edits and the phone.spec/a11y per-brief extras beyond the above.

## Acceptance coverage (42 criteria)
Automated today 41; T19 slots 12 (1, 3, 4, 8, 9, 10, 11, 12, 13, 22, 24, 33); manual smoke 28; manual only 1 (34, p50/p95 report, Task 25). Quoted test names verified against the files by script.

## NANPA
nationalnanpa.com was unreachable (proxy 403), so no NANPA comparison. Cross-checked against Google libphonenumber `resources/geocoding/en/1.txt` (GitHub, secondary, dated data): zero disagreements. Added 30 US codes the table lacked: 308 NE, 909 CA (long-established), and 227 MD, 235 MO, 274 353 WI, 283 326 OH, 324 645 689 728 FL, 327 AR, 329 363 NY, 350 369 738 840 CA, 447 464 730 IL, 472 NC, 572 OK, 582 PA, 686 826 VA, 748 CO, 821 SC, 945 TX. 624 NY, 679 MI, 935 CA are in neither libphonenumber source; kept, unverified. Tests extended (new codes, Canada/Caribbean stay null, table shape). Recheck against NANPA before launch.

## Gaps
R2 is not wired (`r2For` returns null), so manual step M8 cannot pass yet.
