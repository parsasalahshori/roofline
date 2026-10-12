# Task 29 report: S1 manual smoke (scripts and runbook only)

## Built
- guards: apps/api/src/scripts/smoke/storm-guards.ts, apps/api/test/smoke-storm-guards.test.ts (31 tests)
- script: apps/api/src/scripts/smoke/storm.ts, apps/api/package.json (smoke script entry)
- runbook: docs/superpowers/s1-manual-smoke.md

## Review rounds
- Round 1: verify passed, 1 finding, amended (contact check F1=amend).
- Round 2: verify passed, 1 finding, approved (R2-1=approve).
- Round 3: verify passed, 0 findings.

## Minors
- MESH listing uses max-keys=5 ascending, so "last file listed" is from the oldest five.
- Google removal is by hand for non-test accounts (adapter has no remove).
- STORM_MAIL_FROM is always set, so the MAIL_FROM fallback is unused.
- Runbook says the Meta card uses the built-in test image until resvgCardFor lands.
- `python -m hail.main --once` does not exist yet; runbook says to report it first.

## Verify
- npm run typecheck (tsc -b): passed, no output.
- npm run lint (eslint .): passed, no output.
- Database-backed tests not run locally (no Docker); left to CI.
