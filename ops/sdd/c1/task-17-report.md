
# Task 17: C1 CSV export

Built: repo (packages/db/src/repos/export.ts: header arrays, customerExportRows/jobExportRows keyset paging by id, batch 1000); routes (apps/api/src/routes/export.ts: GET /customers.csv and /jobs.csv, view_money_totals, single withTenant, audit export.customers/export.jobs, backpressure-aware streaming); tests (apps/api/test/export.test.ts, DB-backed, not run locally: no Docker/CI).

Review 1: 1 finding, contact check F1 = amend (amended). Review 2: 0 findings.
Minors: audit row lost if stream fails mid-way (rollback); route uses textingCompanyFacts for the zone; address from oldest live property; rep names include inactive members; source columns raw enums.

Verify (typecheck + lint): exit 0, tsc -b and eslint . clean.
