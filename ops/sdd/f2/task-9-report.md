
## Finalize (lead)

Built: apps/api/src/scripts/showcase.ts (lint-showcase, cd6c55e: explicit string types so do/while bodies assign first, rand/pick call order unchanged); README.md (readme-dev-seed, 942fe4b: "Running locally with demo data"; seed:demo usage is `-- --company <slug>` per the script's USAGE).

Review 1: verify passed, 0 findings.

CI rounds (database suites run on GitHub only):
- Run 38178943045 failed: apps/api/test/seed-dev.test.ts:152 asserted on a concatenated email string; removed that malformed line, per-email line checks remain. Fixed (fe82475).
- Run 38179580243 failed: seed-dev.test.ts:133 called toHaveLength on a pg Result; now asserts on `.rows`. Fixed (a320599).
- Run 38180250862 passed (Platform job).

Minors: commit trailers use the Sonnet 5.5 trailer for lead commits; builder commits cd6c55e/942fe4b carry Haiku trailers. The v1 (node:test) job also showed a failure in the first two runs, unrelated to this task (not checked by ci-check).

Verify tail: npm run typecheck (tsc -b) and npm run lint (eslint .) clean; ci-check PASSED (run 38180250862).
