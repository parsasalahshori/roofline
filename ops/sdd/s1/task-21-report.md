
# Task 21 report: YES replies, results and the storms API

## Built
- A-replies: apps/api/src/storm/replies.ts (onStormReply returns { consumed }; newest storm text only, once only, creates/advances a Lead job with next_step), apps/api/src/hooks/twilio.ts (call site per Ruling AV, G1/D1 slot after), apps/api/test/storm-replies.test.ts.
- B-results: packages/db/src/repos/storm-results.ts, apps/api/src/storm/results.ts, apps/api/test/storm-results.test.ts.
- C-routes: apps/api/src/routes/storms.ts (/layer kept first), packages/db/src/repos/storm-api.ts, apps/api/test/storm-routes.test.ts.

## Review rounds
- Round 1: 3 findings. Contact check: F1 approve, F2 approve, F3 amend (fixed/amended as dispositioned).
- Round 2: 0 findings.

## Minors / differences from brief
- messages.direction is 'out'/'in'. JobPatch cannot set storm_id, so a direct update (no audit row) is used.
- Web StormSummary has status; followed the web. Web calls POST /:id/plan as the redraft; allowed for null/draft/expired/declined.
- Possible plan.ts issue: draftStormPlan returns the old taskId for non-draft plans (expired/declined) without redrafting; for lead decision.
- draftStormPlan errors are mapped by message text (constants duplicated in route).
- DB tests (replies, results, routes) rely on raw-SQL seeds validated only by CI.

## Verify
typecheck, lint, shared (667 tests) and web (848 tests) all passed.

## CI
Run 38232677536 (87a3f1d) failed: storm-routes test updated nonexistent table `tasks`; fixed to `agent_tasks` (99af3e5). Run 38234997601 (99af3e5): PASSED (Platform, v1, Hail, E2E).
