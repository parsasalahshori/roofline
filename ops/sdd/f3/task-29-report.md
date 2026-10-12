# F3 Task 29 report: Design kit additions

Built (packages/ui): B1 Checkbox + FilePicker; B2 ProgressBar + ProgressRing; B3 Banner, index.ts exports, test/f3-components.test.tsx (15 tests).
Review round 1: verify passed, 0 findings.
Minors: FilePicker hidden input tabIndex=-1 (Button is keyboard entry); FilePicker messages reuse Field.module.css via FieldMessages; Checkbox description/error sit outside label.
Verify: typecheck, lint, lint:css clean; ui vitest 7 files / 169 tests passed.
Commit 42222d3. CI (ci-check) run 38186289652: PASSED.
