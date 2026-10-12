# Task 1 report: S1 schema, roles, module skeleton

## Built
- P1-schema: global hail tables (hail_runs, storms, storm_contours, spotter_reports) and 11 tenant tables in packages/db/src/schema; migration 0017_storm_schema.sql (generated, no reordering needed: all uniques are inline in CREATE TABLE) plus snapshot. door_stops/door_exclusions footprint_id are bigint with no FK (Ruling SH). Check constraints for sms consent source ('door') and stored_files kinds ('storm_photo','ad_image') re-added.
- P2-grants-tests: 0018_storm_grants_rls.sql (app_hail NOLOGIN guarded create, grants, FORCE RLS + tenant_isolation on 11 tables, app_system column grants); rls.test.ts and migrations.test.ts extended. Note: company_members view (0004) does not expose storm_alert_email.
- P3-skeleton: 17 placeholder repo/system modules, barrels, APP_ROLES.hail, set-role-passwords handles HAIL_DB_PASSWORD, .env.example HAIL_DATABASE_URL.
- app_hail login: run 0018, then set-role-passwords with HAIL_DB_PASSWORD, then give the hail worker HAIL_DATABASE_URL.

## Reviews
- Round 1: verify passed, 0 findings.

## Minors / CI risks
- Sorted order in app_system column_privileges test relies on C collation.
- unique(report_date,time_utc,geom) on spotter_reports: switch to uniqueIndex if CI complains.

## Verify tail
typecheck ok, lint ok, shared vitest 381 passed, drizzle-kit: "No schema changes, nothing to migrate", no check_no_changes file, playwright-core only 1.56.1.
