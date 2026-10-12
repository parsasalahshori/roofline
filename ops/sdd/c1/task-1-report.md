
# C1 Task 1 report: dependency, schema and module skeleton

Commit 2105d50 on branch c1-t1.

## Built
- schema: tenant.ts and global.ts (eight C1 tables, jobs next_step/next_step_on, company_settings work hours/buffer/notice/stuck_after_days, jobs (company_id,id) unique, TENANT_TABLES, texting_registrations messaging_service_sid partial unique), migration 0013_crm_schema.sql, snapshot, journal. Generated with `drizzle-kit generate --name=crm_schema` from packages/db; the jobs unique statement was moved before the composite FKs that reference it.
- grants-rls: 0014_crm_grants_rls.sql (S/I/U on eight tables, DELETE on calendar_busy_blocks and calendar_event_links, RLS enabled/forced, tenant_isolation, app_system column SELECT and policy on calendar_connections), snapshot, journal.
- tests: migrations.test.ts (C1 tenant tables, C1 constraints) and rls.test.ts (calendar_connections, delete tables, UPDATE privileges).
- skeleton: db repos, system calendar-sync, shared crm and availability modules, api package.json dependency, lockfile (playwright-core only 1.56.1).

## Reviews
- Review 1: verify passed, 0 findings.

## Minors
- `npm run db:generate -- --name` does not work with drizzle-kit 0.31; use the direct binary form.
- Unique names pricebooks_company_id_unique and quote_counters_company_id_unique are drizzle auto-named.

## Verify
typecheck and lint passed with no output errors. CI (ci-check) run 38188918207: PASSED, including the database suites.
