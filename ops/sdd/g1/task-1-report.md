
# G1 Task 1 report

Built: shared/more-agents.ts (enum const arrays, barrel export); db schema in tenant.ts (claims, claim_events, follow_up_log, 11 company_settings columns, appointments.moved_by_task_id, messages composite unique); migration 0023_more_agents_schema.sql plus snapshots 0023/0024 and journal idx 15/16; 0024_more_agents_grants_rls.sql (app_tenant S/I/U, ENABLE+FORCE RLS, tenant_isolation); db tests in migrations.test.ts and rls.test.ts.

Review round 1: 0 findings.
Minors: db tests and `drizzle-kit generate` no-change check were not run locally (no Docker/CI down; db tests only); SQL reviewed by reading.

Verify tail: typecheck OK, lint OK, shared vitest 15 files / 381 tests passed.
