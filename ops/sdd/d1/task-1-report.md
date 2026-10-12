# D1 Task 1 report

Built: P1-schema-0019 (D1 tables in tenant.ts/global.ts, migration 0019 + snapshots, journal idx 15/16), P2-grants-rls-tests (0020 grants/RLS, migrations.test.ts and rls.test.ts additions), P3-skeleton-barrels (placeholder repos/system/shared files and barrels). Deps: @anthropic-ai/sdk, ws, @types/ws in apps/api.

Overrides applied: migrations numbered 0019/0020 (Ruling AP); STORED_FILE_KINDS untouched (DJ).

Review 1: verify passed, 0 findings.

Minors: P2 added no app_tenant grant on memberships (global table, no RLS, tenant access via company_members view); lead to confirm.

Verify tail: typecheck ok, lint ok, vitest @roofline/shared 15 files / 381 tests passed.
