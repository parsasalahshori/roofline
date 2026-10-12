
## Task 36 report (commit 9328aec, branch f3-t36)
Built: P1 (stack.ts FAKE_PROVIDERS, fixtures.ts, signup.spec.ts, setup.spec.ts); P2 (import.spec.ts, billing.spec.ts, customers-25.csv, phone.spec.ts and a11y.spec.ts extensions); P3 (f3-acceptance.md, f1-followups.md, README production bullets).
Review 1: 1 finding, handled in the team pass. Contact check 1: approve. Review 2: 0 findings.
Minors / CI risks: setup ring-link assertion may be hidden if user menu collapsed; exactly 4 'Coming with' chips assumed; trial_ended banner looked up as role=button; import flow assumes auto-advance to mapping.
Verify (local only, Ruling AS): typecheck and lint passed; playwright --list shows 30 tests in 9 files, no errors. E2E not run.
