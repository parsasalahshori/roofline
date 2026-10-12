-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the G1 tables
-- that 0023_more_agents_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the three G1 tenant tables. No DELETE: claims are closed, never deleted, and claim
--    events and the follow-up log are history that is only ever appended to.
GRANT SELECT, INSERT, UPDATE ON claims, claim_events, follow_up_log TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the three new tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claims FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON claims
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE claim_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claim_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON claim_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE follow_up_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE follow_up_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON follow_up_log
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- 3. company_settings and appointments: 0002 and 0014 already grant app_tenant table-wide SELECT, INSERT
--    and UPDATE on both, so the new columns (claims_nudge_days, weather_rain_pct, weather_gust_mph,
--    reminder_hour, followup_days, lead_followup_days, review_link, review_delay_days, followup_reviews,
--    followup_leads, followup_proposals on company_settings; moved_by_task_id on appointments) are
--    writable and readable with no column-level grant. A grant here would be redundant, so none is added.

-- 4. app_system: gets NO grant and NO app_system_all policy on claims, claim_events or follow_up_log.
--    The daily agent jobs fan out over companies from the global tables and then work inside withTenant
--    as app_tenant; nothing in G1 needs system-role access to claim data. This is deliberate:
--    test/rls.test.ts expects app_system to hold no privilege on tenant tables except the listed ones.
