# Task 19 report: Wiring the tools and the full call path

## Built
- A-tools-carries: shared tools/system-ctx.ts (systemCtx, isOpenJob) used by caller, jobs, forecast, hail, claim, message, transfer; Ruling EA (job next step only when verified); lookupMyJobs adds propertyIds to shownIds; transferPlan gets real urgency.
- B-index-engine-wiring: tools/index.ts (FRONT_DESK_HANDLERS, toolNamesFor, handlersFor filtered by channel and settings); engine counts failedUnderstanding and askedForPersonCount before shouldTransfer; relay-server and texts use the real handlers.
- C-call-paths-test: call-paths.test.ts with eight scenarios.

## Reviews
- Round 1: 2 findings; contact check F1 approve, F2 amend; applied.
- Round 2: 0 findings.

## Notes
- Engine count-only handoff before Opus goes beyond the brief; not_understood needs 3 turns per shouldTransfer.
- Database-backed tests run on CI only.

## Verify
typecheck, lint, shared (755 tests incl.) and web vitest passed locally; CI result recorded in the task output.

## CI
Run 38275841686 failed Platform (4 test expectations: spam text whitespace, texts tool-name shape/order, tools-jobs shownIds). Fixed in 698c010; run 38277873842 passed Platform and E2E.
