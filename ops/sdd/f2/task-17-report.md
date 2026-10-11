# Task 17 report: phone layout (branch f2-t17, commit ae6dd28)

Built: A (BottomTabs, MoreSheet, phoneIcons, copy, phone.test.tsx), B (Shell/ShellTopBar phone branch, --shell-top-inset/--shell-bottom-inset), C (customers-hit/jobs-hit 40px hit layers, nearestFeature, map-level pin click, tests incl. map-view.test.tsx FakeMap update).
Review 1: 1 finding, fixed. Contact check 1: approve. Review 2: 0 findings.
Minor: a cluster bubble within ~20px of a single pin fires both cluster zoom and pin pick (not in brief).
Verify: web vitest 20 files / 224 tests pass; typecheck pass; eslint on apps and packages clean; lint:css pass; build:web pass.
Root `npm run lint` FAILS on pre-existing ops/team/roofline-team.js:213 (Parsing error: 'return' outside of function), committed in 8823dd1, not part of this task. Fix would need eslint.config.js (owned by parallel P1), so not touched.
CI: run 38179518890 FAILED on that same lint error only (platform job); no test failures from this task.
