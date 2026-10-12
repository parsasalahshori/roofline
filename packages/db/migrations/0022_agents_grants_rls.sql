-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the A1 tables
-- that 0021_agents_schema.sql added (time_baselines, agent_task_events, agent_settings, time_recounts).
-- Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the four A1 tenant tables. No DELETE on any of them. time_baselines and agent_settings
--    are rewritten in place by the owner (baselines are re-keyed, settings are edited), so they get
--    UPDATE. agent_task_events is an immutable event log, and time_recounts is an audit trail of
--    recounted steps, so both are SELECT and INSERT only.
GRANT SELECT, INSERT, UPDATE ON time_baselines, agent_settings TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON agent_task_events, time_recounts TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the four new tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE time_baselines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE time_baselines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON time_baselines
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_task_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_task_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent_task_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent_settings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE time_recounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE time_recounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON time_recounts
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- 3. agent_task_steps: 0002 section 2 already grants app_tenant table-wide SELECT, INSERT and UPDATE
--    on it, so the four new step columns (baseline_key, units, minutes_per_unit, minutes_saved) are
--    readable and writable with no column-level grant. A column-level grant here would be redundant,
--    so none is added. app_system needs nothing new: the worker writes through the tenant role, and no
--    grant or app_system_all policy is added for any table in this file.
