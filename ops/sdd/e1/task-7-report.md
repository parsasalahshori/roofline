
# E1 Task 7: Measurements API (branch e1-t7, commit 55dbfc9)

Built: P1-repo packages/db/src/repos/measurements.ts (footprintsNear, create/get/update, lock check, setPropertyFootprint); P2-measure-routes apps/api/src/estimator/measure.ts and apps/api/src/routes/measurements.ts (POST/GET/PATCH, stubs replaced); P3-tests apps/api/test/measurements.test.ts (11 cases). Ruling EH: API answers shared MeasurementView; no difference from the brief found.

Lead change: eslint.config.js DB_SYSTEM_ALLOWED gained apps/api/src/estimator/measure.ts (measure.ts needs footprintStateStatus from @roofline/db/system; option (a) from P2).

Review rounds: R1 3 findings (F1-F3 amended); R2 1 finding (R2-1 approved/fixed); R3 0 findings.

Minors / open points: draw-mode estimate keeps stored valleyFt and pitch (not literal zeros); a 'ready' unsent proposal also locks the measurement (sent_at not null OR status <> 'draft'); rings are stored closed so round trips return the closing corner; includedStructures ids are numeric strings (bigserial).

Verify: typecheck and lint clean. CI via ci-check: run 38206676369, Platform and E2E jobs PASSED.
