# G1 Task 2b report: step types, baselines and the claims guard

Built (commit 20978ed, branch g1-t2b):
- P1-steps-baselines: four G1 STEP_TYPES with payload schemas, previews, registry lines (steps.ts); four TIME_BASELINES entries (agents.ts).
- P2-claims-guard: claimsGuard (claims-guard.ts), re-exported from more-agents.ts; tests in claims-guard.test.ts.
- P3-step-tests: g1-steps.test.ts new; steps.test.ts and agents.test.ts updated for the new counts and keys.

Review round 1: verify passed, 0 findings.

Minors: tests were written after the implementation (no failing-first run). insurer_contact matches on verb plus insurer word, so "We'll call the adjuster" also hits. Message body is not trimmed. No web text added; web copy-rules unchanged. No api/db test enumerates STEP_TYPES/TIME_BASELINES exactly.

Verify: shared vitest 26 files / 973 tests passed; web copy-rules 5 passed; typecheck and lint clean. CI run 38199413446 passed.
