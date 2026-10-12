# C1 Task 3 report: shared availability model

Commit 9f7a2d7 on branch c1-t3. CI run 38189686463 PASSED.

## Built
- A-workhours (packages/shared/src/availability.ts): DEFAULT_WORK_HOURS, WorkHoursSchema, workIntervals, mergeIntervals.
- B-findslots: findSlots, which ended up in availability.ts (there is no separate availability-slots.ts file).
- C-tests (packages/shared/test/availability.test.ts): constants, schema, slots, buffers, notice, clipping, DST, mergeIntervals.

## Reviews
- Review 1: 2 findings, both approved at contact check and fixed. Verify passed.
- Review 2: 0 findings.

## Minors
- Brief's DST text said 13:00Z for 2026-11-01; CST gives 14:00Z, the test uses 14:00Z.

## Verify tail
shared vitest: 12 files, 300 tests passed; tsc -b clean; eslint clean.
