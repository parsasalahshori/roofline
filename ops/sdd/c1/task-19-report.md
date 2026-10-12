
## Task 19 final report (C1 Web: pipeline board and list)

Built: B1-board (Board, BoardColumn, JobCardView, BoardFilters + CSS modules); B2-move-list (jobs api.ts, MoveJobMenu, MoveJobSheet, JobsList, JobsWindow); B3-timeline-tests (timeline api/Timeline/NoteComposer, timeline.test, jobs-board.test, c1-routes.test).
Review 1: verify failed, 6 findings; contact check F1 approve (fixed), F2-F6 amend (amended).
Review 2: verify passed, 0 findings.
Minors: Cancel in MoveJobSheet also triggers MoveJobMenu onMoved; Pill without href renders a button; no Prettier config so files not reformatted.
Final verify (lead): web vitest 45 files / 449 tests passed; typecheck, lint, lint:css, build:web all clean (only the existing chunk-size warning).
Commit: da9b1e1 on c1-t19, not pushed.
