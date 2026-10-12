# R8 report (Ruling BF): ad account links to one company only; S1 grants trimmed

Built:
- A-db: global partial unique index `ad_accounts_platform_external_live_uq` (platform, external_account_id) where status <> 'revoked' in the drizzle schema, amended into 0018 and meta/0018_snapshot.json (drizzle-kit reports no changes). 0018 grants trimmed: app_system spotter_reports SELECT+INSERT (no ALL), app_hail no UPDATE on hail_runs (writer.py only inserts; storm_contours keeps UPDATE for its ON CONFLICT DO UPDATE upsert), company_storms column grant (id, company_id, status), email_opt_outs SELECT (id) only; recordEmailOptOut uses `on conflict do nothing`. rls.test, migrations.test (index across two companies) and spotter.test (owner cleanup) updated.
- B-api: connect claims the row as pending inside withTenant before any platform call; 23505 on the index becomes 409 AD_ACCOUNT_TAKEN with no platform call; settle updates the claimed row. Revoke comment documents why only a live holder unlinks.
- C-api-tests: ads-routes.test.ts covers A connecting B's Google and Meta accounts (409, 0 provider calls, B unchanged), A's delete never unlinking, and connect after B revokes.

Review rounds: 3 verify rounds, each 1 finding; contact checks approve/amend/approve. Final amend addressed here: the email_opt_outs conflict target removed so the SELECT(email) drop holds.
Minors: db/api tests prove on CI only (no Docker).
Verify: typecheck, lint, shared vitest (668 passed) and drizzle-kit "No schema changes" all passed.

CI: run 38268684621 (492563f) failed on ad-sync.test seed (two companies, same customer id vs the new index): fixed in 4452777 (company b seeds its own customer id in ad-sync and ad-spend-sync-scheduler tests). Run 38270696502 (4452777): Hail and v1 green; Platform red only on exact-report.test.ts:130 (the E1 time bomb, fixed on s1-storm in b46f1f5, which this branch predates); E2E red, log not readable through the proxy (blob host denied), cause not confirmed. Judge both on the merged head.
