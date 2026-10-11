
# F3 Task 1: dependencies, F3 schema and module skeleton

Built (package verify-and-fix, WIP commit 4e6971a): F3 global/tenant schema, enums, usage repo, db/system barrels, shared setup/imports/index, migration 0011_f3_grants_rls.sql, tests (migrations, rls, usage, f3-constants). Verification found nothing to change.

Review 1: verify passed, 0 findings.
Minors: none. No new commit was made (tree clean); HEAD stays the WIP commit 4e6971a, whose message still starts with "wip(f3-t1)".

Verify: npm run typecheck and npm run lint exit 0 (tsc -b, eslint . clean).
CI: ci-check PASSED, run 38177661443 (platform job) for f3-t1@4e6971a.
