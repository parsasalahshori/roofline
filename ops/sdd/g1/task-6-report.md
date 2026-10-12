# G1 Task 6: Claims record and API (branch g1-t6)

Built: shared claim types and limits (packages/shared/src/claims.ts); db repo getJobClaim, saveClaim, listClaims (packages/db/src/repos/claims.ts, one barrel line); api routes jobClaimRoutes and claimBoardRoutes plus app.ts mounts; db and api tests.

Review round 1: 0 findings.
CI round 1 (run 38210796289, b353229): Platform failed. api test "a status change adds history" read events by position, but both events share one clock instant and the repo's tie-break is by random id. Fixed in the test (look up by status). Not a repo bug.
CI round 2 (run 38211865227, 41acdb6): Platform and E2E passed.

Minors: brief says claimIntakes.takenBy 'assistant'/'person'; the real values are CLAIM_TAKEN_BY = front_desk, user (tests use front_desk). byName is null for agent events (tenant role cannot read users). Empty adjusterPhone/adjusterEmail is a 400, not null.

Verify tail: typecheck and lint clean; vitest @roofline/shared 27 files, 995 tests passed.
