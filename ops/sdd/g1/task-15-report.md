# G1 Task 15 report

Commit a74912b on g1-t15. CI run 38256307430: Platform and E2E jobs passed.

## Built
- P1-api-core: Claims, Scheduler and Follow-up rows start paused (claimRunNow, metrics, run-now 409 'Turn this agent on first.', pause route); rule sentences and facts; schedulerAgentOn removed.
- P2-jobs: claims, follow-up and four scheduler jobs plus the claims reply gate use g1AgentOn; new g1-agent-on.test.ts.
- P3-web: Turn on sheet, PauseSwitch, card line, run-now labels and once-per-day line, Settings tab shows rules only.

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- Web implementation was written before g1-turn-on test (not seen failing first).
- Duplicate company-status checks kept in jobs (harmless).

## Verify tail
typecheck (tsc -b) and lint (eslint .) clean; ci-check PASSED (run 38256307430).
