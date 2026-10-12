# F3 Task 37: manual smoke suite (commit 3dc24d9, branch f3-t37)

## Built
- B1-stripe-smoke: apps/api/src/scripts/smoke/stripe-test-clock.ts (test clock, trial, two meter events, invoice item, advance 15 days, invoice print).
- B2-texting-smoke-and-guards: smoke/guards.ts, smoke/texting-real-brand.ts, .gitignore entry for .smoke-texting.json.
- B3-runbook-scripts-test: docs/superpowers/f3-manual-smoke.md, smoke:stripe and smoke:texting lines in apps/api/package.json, apps/api/test/smoke-guards.test.ts (5 pure tests).

## Reviews
- Review 1: 1 finding, amended. Contact check 1: amended. Review 2: 0 findings.

## Minors
- State file mode 0o600 applies only on creation.
- The guards test was not run locally (api project needs PostGIS); CI ran it.
- smoke:* scripts were never run.

## Verify
- typecheck and lint: passed (no output errors).
- ci-check: run 38193748890 PASSED (Platform job passed) for f3-t37@3dc24d9.
