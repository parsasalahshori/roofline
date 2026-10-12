-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the C1 tables
-- that 0013_crm_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the eight C1 tenant tables. No DELETE except the calendar link and busy-block rows
--    (below), which are rebuilt from the provider, and a calendar connection, which disconnecting
--    deletes (its token goes with it; links and busy blocks cascade). Appointments are canceled or
--    archived, and quotes, schedules, pricebooks and counters are never deleted.
GRANT SELECT, INSERT, UPDATE ON
  appointments, calendar_connections, calendar_event_links, calendar_busy_blocks,
  member_schedules, pricebooks, quotes, quote_counters
  TO app_tenant;
--> statement-breakpoint
GRANT DELETE ON calendar_busy_blocks, calendar_event_links, calendar_connections TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the eight new tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON appointments
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE calendar_connections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_connections FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_connections
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE calendar_event_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_event_links FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_event_links
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE calendar_busy_blocks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calendar_busy_blocks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calendar_busy_blocks
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE member_schedules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE member_schedules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON member_schedules
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE pricebooks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricebooks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON pricebooks
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE quotes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON quotes
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE quote_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE quote_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON quote_counters
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 3. company_settings and jobs: 0002 section 2 already grants app_tenant table-wide SELECT, INSERT and
--    UPDATE on both, so the new columns (work_hours, travel_buffer_minutes, min_notice_minutes,
--    stuck_after_days, next_step, next_step_on) are writable and readable with no column-level grant.
--    A column-level grant here would be redundant, so none is added. Both tables have no column-level
--    SELECT restriction either, so there is nothing to extend.

-- 4. app_system: the calendar sync fan-out reads only the ids, owner, status and sync timing of a
--    connection, never the encrypted credentials or the account email. Its app_system_all policy
--    (below) lets every row through on this table, so this column grant is its real limit.
GRANT SELECT (id, company_id, user_id, status, last_synced_at) ON calendar_connections TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON calendar_connections FOR ALL TO app_system USING (true) WITH CHECK (true);
