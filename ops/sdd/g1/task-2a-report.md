# G1 Task 2a report (branch g1-t2a, commit c69f177)

Built (packages/shared only): B1 follow-up-rules.ts (limits, followUpAllowed, proposal/lead/claim due rules); B2 weather-claim-flow.ts (HourlyForecast, weatherRisk, CLAIM_STATUS_FLOW, canMoveClaim); B3 test/more-agents.test.ts. more-agents.ts re-exports the two new files (barrel untouched).

Deviation: brief's `WorkHours` collides with availability.ts `WorkHours` in the barrel (TS2308); B2 exported `LocalWorkHours` instead (same shape {start,end}). Lead accepted; Task 9 should import HourlyForecast, not WorkHours.

Review 1: verify passed, 0 findings.

Verify (local): shared vitest 16 files / 425 tests passed; typecheck and lint clean.

CI: run 38196334904 FAILED on Platform job, step "npm test", not caused by this task. packages/db global setup fails migrating Task 1's schema: `ALTER TABLE follow_up_log ADD CONSTRAINT follow_up_log_company_message_fk FOREIGN KEY (company_id,message_id) REFERENCES messages(company_id,id)` -> error 42830 "there is no unique constraint matching given keys for referenced table messages". This is a g1-t1 (15f674b) defect; it needs a fix on g1-t1 (add a unique (company_id,id) on messages, or drop the composite FK), then t2a restacked. E2E job also failed (likely same base). No fix made here: packages/db is outside Task 2a scope.
