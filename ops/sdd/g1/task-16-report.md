# G1 Task 16: claim section on jobs and the claims board

## Built
- P1-claim-section: ClaimSection.tsx and .module.css on the job window; one import and one mount line in JobSections.tsx.
- P2-claims-board: ClaimsBoard.tsx and .module.css; one import and one line in AgentPage.tsx.
- P3-tests: claim-section.test.tsx (7), claims-board.test.tsx (4), claims stub in job-window.test.tsx.
- Also committed: copy/claims.ts and features/claims/api.ts (untracked in the worktree, needed by the build).

## Review rounds
- Review 1: verify passed, 0 findings.
- CI round 1 (run 38218774059, commit 1110e31): Platform failed, a1-routes "shows the claims page with its name" saw unstubbed GET /api/claims and GET /api/company. Fixed in 08bcfdc by stubbing both in that test. E2E passed.

## Minors
- useCompanyZone and parseDollars are duplicated in ClaimSection rather than exported.

## Verify
Focused vitest (claim, copy-rules, appointments-form, job-window), lint, lint:css, typecheck, build:web all passed; full web project passed after the a1-routes fix (703 tests).
