
# Task 12: lease heartbeat (f3-t12, commit 10693ab)

Built (all in WIP commit 10693ab, no new commit needed):
- packages/db: renewStepLease in src/repos/tasks.ts (filters company, id, status running, runSeq, lease not null; keeps updatedAt), exported from src/index.ts.
- apps/api: src/tasks/lease.ts (LEASE_MS, LEASE_RENEW_EVERY_MS = 60s, leaseKeeper with sticky lost flag), re-exported from runner.ts; sendSmsBatch awaits lease.keep() before each customer and returns running when false.
- apps/api/test/lease-heartbeat.test.ts: 6 tests (3 brief tests plus keeper and renewStepLease edge cases).

Review round 1: verify-lint, 0 findings. Nothing changed.

Verify: npm run typecheck and npm run lint both clean (no output beyond script banners).
CI run 38177661676 on 10693ab: first attempt failed on known flake rep-visibility.test.ts:400 (UUID contained 333); lease-heartbeat.test.ts 6/6 passed. Rerun of failed jobs: Platform (lint, typecheck, tests) succeeded. "v1 (node:test)" job fails 7/27 NOAA-related tests; not touched by this task (unrelated, pre-existing).
