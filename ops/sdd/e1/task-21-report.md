# E1 Task 21 report: end-to-end tests, acceptance map, docs

Built: A-estimator-e2e (seedFootprintFixture, OMAHA_ADDRESS, makeAndSendProposal, estimator.spec.ts), B-homeowner-phone-a11y
(homeowner.spec.ts at 375x812 via test.use, phone.spec.ts + a11y.spec.ts additions), C-acceptance-docs
(docs/superpowers/e1-acceptance.md, README footprints note).

Reviews: round 1 had 3 findings (F1 approved, F2 and F3 amended); round 2 had 0.

Local verify: typecheck, lint, playwright --list (38 tests), web vitest (733 passed) all green.

CI (E2E job on GitHub; Platform and v1 passed every time):
- 149815c: E2E failed, 7 tests, all at the send step "Done" wait in makeAndSendProposal (31 others passed).
- 01a41d7 (company/property zone set to Etc/GMT offset): same failure.
- f4afe11 (diagnostic added): window said "We couldn't work out this customer's local time." because isTimeZone rejects
  fixed offsets. Run 38241378214.
- Fix committed after that (real place names, zone chosen where it is 10:00-17:00 now): NOT pushed, because the
  2-retry limit for ci-check was used up. Needs one more ci-check run.
Open: estimator.spec test 2 asserts "Working on it" (brief said "Waiting for the report"; that copy does not exist).
homeowner.spec runs in the desktop project at phone viewport. The Won check matches by dollar text only.
