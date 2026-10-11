
# F3 Task 7 report: Import rows, consent and the import plan

Built (commit 76aa441 on f3-t7):
- A-normalize: apps/api/src/imports/normalize.ts (normalizeRow, normalizeState via toUsStateCode, normalizeZip, normalizeStage).
- B-consent-plan: packages/shared/src/consent.ts (importConsent, consentAttestationText), packages/shared/test/consent.test.ts (13 cases), apps/api/src/imports/plan.ts (planImport, previewRows).
- C-fixture-tests: apps/api/test/fixtures/import-1000.ts, apps/api/test/import-plan.test.ts (5 tests).

Review round 1: verify passed, 0 findings.

Minors: parse.ts '20,000' literal left untouched (task does not touch parse.ts). Name split reading: displayName split only when first and last both empty.

Verify: typecheck, lint, shared vitest (11 files, 261 tests) passed. CI run 38181073895 passed (ci-check PASSED).
