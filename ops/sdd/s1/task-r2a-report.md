# Task R2a report: storm plan re-draft

## Built
- A-db (packages/db): replaceDraftPlan locks cs and t (for update of cs, t), accepts draft/expired/declined, declines only a draft old task (skipping its pending/awaiting_owner steps), leaves expired/declined tasks alone. New packages/db/test/storm-plans.test.ts incl. a lock-order test.
- B-plan (apps/api): plan.ts returns { taskId } | null (null when paused, Ruling BC), re-drafts draft/expired/declined, shared plan-errors.ts; storm-draft job handler drops PLAN_NOT_FOUND / PLAN_DISMISSED; tests updated.
- C-route (apps/api): POST /:id/plan drafts for no plan or draft/expired/declined, 409 PLAN_EXISTS otherwise, null -> 409 PLAN_PAUSED, success body still { taskId }; GET / honours ?since= (default 30 days, 400 on garbage). Tests in storm-routes.test.ts and new storm-routes-paused.test.ts.

## Review rounds
- Round 1: 1 finding (F1), contact check: amend, applied.
- Round 2: 1 finding (R2a-1), contact check: approve, applied.
- Round 3: 0 findings.

## Minors
- '2026-13-45' since case relies on Date.parse rejection.
- pg_stat_activity query in the lock-order test may need adjusting on CI.

## Verify tail
typecheck (tsc -b) clean, eslint clean, vitest @roofline/shared: 28 files, 668 tests passed. DB/API tests run on CI only.

## CI
- Run 38250841615 (5321093): Platform failed. storm-alerts.test.ts expects a synchronous throw from the storm-draft handler for a bad id; making the handler async broke it. Fixed in aa9f2af: validation stays synchronous, the draft runs in runStormDraft (storm-plan.test.ts line 481 back to a sync toThrow).
- Run 38254123531 (aa9f2af): Platform, E2E, v1, Hail all passed.
