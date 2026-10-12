# E1 Task 22 report: manual smoke (script, guards, runbook)

Branch e1-t22, commit 697e141, CI run 38239203155 passed (Platform, E2E).

Built: A-guards (apps/api/src/scripts/smoke/estimator-guards.ts, apps/api/test/smoke-estimator-guards.test.ts); B-script (apps/api/src/scripts/smoke/estimator.ts, smoke:estimator in apps/api/package.json); C-runbook (docs/superpowers/e1-manual-smoke.md). Nothing was run against a live provider.

Review round 1: verify passed, 0 findings.

Notes/minors: C1 T29 smoke:calendar not built (followed F3 layout). Omaha address from fakes.test.ts, owner must confirm. No separate token check. SMS flow needs SMOKE_OWNER_USER_ID. Second SMS run prints FAIL (proposal no longer draft) and sends nothing. No manual footprints trigger exists; runbook gives read-only SQL.

Verify: npm run typecheck and npm run lint passed (tsc -b, eslint .).
