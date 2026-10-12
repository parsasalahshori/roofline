# Merge notes: sibling 1, C1 wave 2 (T2 c1-t2, T3 c1-t3, T4 c1-t4)

Group check by Opus contact 61 (workflow run wf_a98d214b-0ab).

## Base and post-run merges (sibling 1)

- All three branched from scratch commit ce04456 (f3-setup bdc0f9f + a stub of C1 T1's shared slice, identical to T1's availability.ts constants).
- After the run, origin/c1-crm 7d37cbc (T1) was merged into each branch (--no-ff). Resolution: packages/shared/src/index.ts = c1-crm's; pipeline.ts / availability.ts / crm.ts / csv.ts = the task's. After this each branch differs from c1-crm only in its own task files (T4 also keeps its scratch stub commit c4c42d5).
- **T4 scratch commit c4c42d5** stubs T2's BOARD_STAGES/BoardStage in pipeline.ts and T3's WEEKDAYS/Weekday/WorkHours in availability.ts so the branch typechecks alone. Merge T2 and T3 into c1-crm first; then merging T4 conflicts on pipeline.ts and availability.ts: take c1-crm's (T2/T3) version of both. crm.ts and csv.ts are T4's.
- **T3 carry (controller):** bbad8ec makes @roofline/shared the single source for work hours: packages/db/src/schema/tenant.ts drops WeekdayKey, WeeklyHours and its DEFAULT_WORK_HOURS, and types company_settings.work_hours and member_schedules.weekly_hours as WorkHours with the shared DEFAULT_WORK_HOURS default. drizzle-kit generate reports no schema change.

## Group-check merge notes

Order: merge T2 (c1-t2, e4b87e9) and T3 (c1-t3, 9f7a2d7) first. They touch separate files (pipeline.ts plus its test, availability.ts plus its test) and merge cleanly together; I checked with git merge-tree. Merge T4 (c1-t4, 9e0f833) last.

T4 will conflict in two files, both because of its scratch commit c4c42d5:
(1) packages/shared/src/pipeline.ts: take T2's version in full.
(2) packages/shared/src/availability.ts: take T3's version in full.
In both files the stub's content is word for word the same as what T2 and T3 export, so the resolution takes nothing from T4. An alternative is `git revert c4c42d5` on c1-t4 before merging, which avoids the conflicts. In a simulation that treated the stub as already dropped, T4 merged with no conflicts. Everything else in T4 merges cleanly: crm.ts, csv.ts, crm-types.test.ts and csv.test.ts.

Interfaces:
- T4's crm.ts consumes BoardStage from pipeline.ts (T2) and WorkHours from availability.ts (T3). Both match the plan and T4's imports.
- index.ts already re-exports pipeline, availability, crm and csv, so it needs no edit.
- No exported names collide across the three tasks once the stub is gone.

Copy rules: the new `as const` arrays (BOARD_STAGES, WEEKDAYS) contain no snake_case tokens, so the web copy-rules ENUM_TOKENS guard is unaffected. None of the three tasks touches the UI, CSS or JSX.

After merging, run `/home/user/roofline/ops/bin/slot npm run typecheck` and `npx vitest run --project @roofline/shared` (pipeline, availability, csv and crm-types) to confirm the stub is gone and nothing is declared twice.

Paths: /home/user/wt/c1-t2/packages/shared/src/pipeline.ts, /home/user/wt/c1-t3/packages/shared/src/availability.ts, /home/user/wt/c1-t4/packages/shared/src/{crm.ts,csv.ts,pipeline.ts,availability.ts}.

## Issues

- **important** (tasks 2, 4): T4 carries the scratch commit c4c42d5 ('stub T2 BoardStage and T3 WorkHours type exports - drop at merge'). It replaces pipeline.ts line 1 `export {};` with its own BOARD_STAGES/BoardStage. T2 rewrites the same line, so merging both gives a content conflict in packages/shared/src/pipeline.ts. I confirmed this with git merge-tree.
  - Suggestion: Merge T2 before T4. When the conflict comes up, take T2's pipeline.ts in full (`git checkout --ours packages/shared/src/pipeline.ts` when T2 is already on the integration branch). The stub's two lines are word for word the same as T2's, so nothing from T4 is lost.
- **important** (tasks 3, 4): The same scratch commit appends WEEKDAYS, Weekday and WorkHours right after the QUOTE_STATUSES lines in availability.ts. T3 appends its block at the same spot, so the merge gives a content conflict in packages/shared/src/availability.ts. Keeping both sides would declare WEEKDAYS, Weekday and WorkHours twice, which TypeScript rejects.
  - Suggestion: Merge T3 before T4 and take T3's availability.ts in full (--ours). T3's WEEKDAYS, Weekday and WorkHours have the same shape as the stub, so crm.ts (`import type { WorkHours } from './availability.ts'`) and crm-types.test.ts keep compiling. After resolving, check that each of the two files has exactly one WEEKDAYS and one BOARD_STAGES declaration.
- **minor** (tasks 4): The new shared csvCell/toCsv in packages/shared/src/csv.ts repeats existing logic: the private csvValue in apps/api/src/imports/skipped-csv.ts has the same formula guard (=,+,-,@,\t,\r) and RFC 4180 quoting. That leaves two copies to keep in sync.
  - Suggestion: Not a merge blocker. A later cleanup could make skippedCsv call toCsv/csvCell from @roofline/shared. The output stays the same: CRLF line endings with a trailing CRLF.
- **minor** (tasks 3): In availability.ts, T3 placed `import { z } from 'zod'` and `import { localDate } from './time-zone.ts'` in the middle of the file, after Task 1's exports. ESM hoists imports, so this runs fine, and eslint.config.js has no import/first rule. It is still unusual style, and other appends to this file could land on the same lines.
  - Suggestion: Optional: move both imports to the top of availability.ts after the merge. No functional change.
- **minor** (tasks 2, 3): T2's daysInStage (dayNumber helper) and T3's workIntervals each parse the 'YYYY-MM-DD' string from localDate into a UTC day number in their own way. The two helpers are small and do nearly the same thing.
  - Suggestion: No action needed for this merge. A shared day-number helper in time-zone.ts could replace both later.
