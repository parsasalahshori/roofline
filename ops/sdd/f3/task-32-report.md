# Task 32 report: Web: the Setup window and the progress ring

Commit 2b7918c on f3-t32. CI run 38190092520 passed.

## Built
- Package A: SetupTab, SetupRow, and their CSS modules.
- Package B: CompanyBasicsSheet, SetupRing, and the UserMenu.module.css .root flex rule.
- Package C: setup hooks in api.ts, types, copy, tests, and fixture fixes.

## Reviews
- Round 1: verify failed with 3 findings. Contact check: F1 amend, F2 approve, F3 approve. All were fixed.
- Round 2: verify passed, 0 findings.

## Minors
- The status chip is a span, since Pill renders a button.
- The sheet adds the saved radius as an extra option when it is not 10/20/40/60.

## Verify
typecheck, lint and lint:css clean. Web vitest: 37 files and 365 tests passed.
