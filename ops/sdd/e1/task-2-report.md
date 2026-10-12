
# Task 2 report: shared roof geometry and the instant estimate

Commit 4faa753 on e1-t2. CI run 38194659737: Platform job passed.

## Built
- P1-geometry: packages/shared/src/roof-geometry.ts (five public exports; cleanRing, project, convexHull, orient, properlyCross private) and test/roof-geometry.test.ts.
- P2-instant-estimate: packages/shared/src/roof.ts (types kept exactly, re-export of roof-geometry, instantEstimate) and test/roof-estimate.test.ts.
- P3-fixtures-and-brief-tests: test/fixtures/outlines.ts and test/roof.test.ts.

## Review rounds
- Round 1: verify passed, 0 findings. No fixes.

## Minors
- offsetOutline is in the brief's Split line but not its Interfaces list: not implemented, not tested.
- Brief surface 1,498.1 is 1,498.2 from 1340 x 1.118034; test tolerance covers both.
- perimeterFt with 2 points returns 2x segment; minRotatedRectangle with 2 distinct hull points returns shortFt 0.

## Verify tail
shared vitest: 18 files, 408 tests passed; typecheck (tsc -b) and lint (eslint .) clean; CI Platform job success.
