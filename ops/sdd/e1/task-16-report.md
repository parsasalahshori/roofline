
# Task 16 report: measure view with the outline editor (branch e1-t16, a6c270e)

Built: outline-editor (OutlineEditor.ts: pure reducers + MapLibre vertex editor), measure-window (MeasureWindow.tsx/.module.css), tests-api-copy (api.ts hooks, types.ts, copy/measure.ts, measure.test.tsx, e1-routes.test.tsx tweak).

Reviews: Review 1 verify failed with 5 findings; contact check F1=amend, F2=amend, F3=amend, F4=approve, F5=amend; addressed before this commit. Review 2 passed, 0 findings.

Minors / for T7 and T8: MeasurementView (types.ts) is assumed; PATCH must return a full view; exact-report answers 201 {taskId} and window links /approvals/<taskId>; 409 = locked; POST /api/proposals {measurementId} -> {id} assumed; Make proposal navigates to /estimator/proposals/<id>. Area row shows surfaceSqFt. Possible flicker: map effect depends on [m.center] (new array after each PATCH cache write); suggest depending on center[0]/center[1]. Editor colours are inline hex, not tokens.

Verify tail: web vitest 46 files / 467 tests passed; typecheck, lint, lint:css, build:web passed. CI: run 38201086467 PASSED (a6c270e).
