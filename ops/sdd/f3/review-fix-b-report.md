
# F3 review fixes, group B (api/db) - branch f3-review-b, commit 9b6554b

## Built
- P1 (packages/db import-apply.ts, apps/api/test/import-apply-consent.test.ts): R6 applyImportChunk takes lockRecipients (advisory, sorted ids) then customers FOR UPDATE ordered by id, consent from locked rows, optedOut when ANY phone is on opt_outs (Ruling AM). R7 one ensureOptOuts per chunk for phones of revoked / do_not_contact working customers. 4 tests.
- P2 (usage.ts meterTargetFor, report-usage.ts, report-usage.test.ts, texting-routes.ts, policies.ts, texting-submit.test.ts, policy-pages.test.ts): R8 meter batch only with a live subscription (active or past_due), invoice items unconditional. R10 website = policyUrls(config, slug).privacy; GET / on a company host 302 to /privacy.
- P3 (sweep-imports.ts, worker.ts SCHEDULES, routes/imports.ts try/catch around sendJob, pgboss.test.ts, imports-api.test.ts, sweep-imports.test.ts; repos/imports.ts staleImportIds, system/scheduler.ts allCompanyIds): R9. app_system has no grant on imports and Ruling AO forbids a migration, so the sweep lists company ids on app_system, then reads stale imports per company in an app_tenant transaction (queued older than 2 min, processing older than 30 min) and re-sends with singletonKey = importId. Contact check 1 amended R9 to this shape.

## Rounds
- Review 1: 1 finding, fixed. Contact check 1: RB-R9 amended (as above). Review 2: 0 findings.
- Minors: report-usage test sets status 'trial' - unchecked against the status enum (a CHECK might reject it); verify on CI. The optional 6-hour failImport of dead processing imports was not implemented.

## Ruling for the ledger (R10)
The hosted-page website is the FULL privacy URL, not its origin. Departs from plan line 2394 and T27 brief line 46: the company host answered 404 on /, and vetting needs a 200 page with legal name, address and privacy text.

## Verify
Local `npm run typecheck` and `npm run lint`: both clean (no output after the script header).
CI run 38195250438: FAILED to start. All three jobs ended in 1-2 s with the annotation "The job was not started because recent account payments have failed or your spending limit needs to be increased." No test ran; this is a GitHub billing problem, not a code failure. The DB-backed tests (import-apply-consent, report-usage, sweep-imports, texting-submit, policy-pages, pgboss) are unverified. Re-run ci-check after billing is fixed.
