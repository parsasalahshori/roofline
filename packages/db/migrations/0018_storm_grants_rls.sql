-- Custom migration (drizzle-kit generate --custom): the app_hail role, grants and row-level security for the
-- S1 (Storm Scout) tables that 0017_storm_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_hail: the hail worker's role (services/hail). Created NOLOGIN with the same guarded block 0002 uses
--    for app_tenant and app_system, and never BYPASSRLS. Login is granted by ops, never by a migration:
--    `ALTER ROLE app_hail WITH LOGIN PASSWORD ...` (scripts/set-role-passwords does this when
--    HAIL_DB_PASSWORD is set), and HAIL_DATABASE_URL is the worker's connection string.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_hail') THEN
    CREATE ROLE app_hail NOLOGIN NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_hail' AND rolbypassrls) THEN
    ALTER ROLE app_hail NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_hail;
--> statement-breakpoint

-- 2. app_hail: the three global hail tables, and nothing else. It writes runs, storms and contours;
--    DELETE only on storm_contours (a storm's contours are replaced when it is reprocessed). hail_runs.id is a
--    bigserial, so its inserts need the sequence; storms uses a uuid and storm_contours has no sequence.
--    It gets no grant on spotter_reports or on any tenant table.
GRANT SELECT, INSERT, UPDATE ON hail_runs, storms, storm_contours TO app_hail;
--> statement-breakpoint
GRANT DELETE ON storm_contours TO app_hail;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE hail_runs_id_seq TO app_hail;
--> statement-breakpoint

-- 3. Global hail tables carry no company_id and no RLS (they hold no tenant data). app_tenant reads them
--    (a company's storm map and the spotter overlay) and writes none.
GRANT SELECT ON hail_runs, storms, storm_contours, spotter_reports TO app_tenant;
--> statement-breakpoint

-- 4. app_system: the spotter-report loader runs as app_system, so it has ALL on spotter_reports (and its
--    bigserial sequence). On storms it reads, and may update only place_name (the reverse-geocoded label).
GRANT ALL ON spotter_reports TO app_system;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE spotter_reports_id_seq TO app_system;
--> statement-breakpoint
GRANT SELECT ON storms TO app_system;
--> statement-breakpoint
GRANT UPDATE (place_name) ON storms TO app_system;
--> statement-breakpoint

-- 5. app_tenant: the eleven S1 tenant tables. DELETE only on door_exclusions (a rep undoes a Do-not-knock
--    mark) and storm_photos (a company removes a photo); every other row is kept: storms, hits, routes,
--    stops, ad records, pages, requests and opt-outs change status instead of being deleted.
GRANT SELECT, INSERT, UPDATE ON
  company_storms, storm_hits, door_routes, door_stops, ad_accounts, ad_campaigns,
  storm_pages, storm_requests, email_opt_outs
  TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON door_exclusions, storm_photos TO app_tenant;
--> statement-breakpoint

-- 6. Row-level security on the eleven new tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE company_storms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_storms FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company_storms
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE storm_hits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE storm_hits FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON storm_hits
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE door_routes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_routes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON door_routes
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE door_stops ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_stops FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON door_stops
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE door_exclusions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE door_exclusions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON door_exclusions
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE ad_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ad_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ad_accounts
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE ad_campaigns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ad_campaigns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ad_campaigns
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE storm_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE storm_pages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON storm_pages
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE storm_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE storm_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON storm_requests
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE email_opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE email_opt_outs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON email_opt_outs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE storm_photos ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE storm_photos FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON storm_photos
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 7. app_system: column-level access to four tenant tables, for the storm-match and ad-sync fan-outs, the
--    public storm page lookup and the public unsubscribe. The column grants are the real limit. The
--    app_system_all policies let every row through on these tables (app_system is not RLS-exempt), so the
--    column list alone decides what app_system can see: ids, status and timing, never content.
--    email_opt_outs also takes INSERT (company_id, email, source, at): the public unsubscribe link records an
--    opt-out for a company without a tenant session (`at` has a default, so an insert may omit it).
--    These are column grants only: app_system holds no table-level privilege on any of the four.
GRANT SELECT (id, company_id, storm_id, status, plan_task_id, last_matched_at) ON company_storms TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON company_storms FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, company_id, status, external_campaign_id, platform) ON ad_campaigns TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON ad_campaigns FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, company_id, code, active_until, company_storm_id) ON storm_pages TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON storm_pages FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, company_id, email) ON email_opt_outs TO app_system;
--> statement-breakpoint
GRANT INSERT (company_id, email, source, at) ON email_opt_outs TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON email_opt_outs FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 8. New columns on existing tables need no grant of their own (verified against 0002 and the later migrations):
--    - company_settings (the seven storm_* columns): 0002 section 2 grants app_tenant table-wide SELECT,
--      INSERT and UPDATE on company_settings, and no later migration restricts that by column.
--    - memberships.storm_alert_email: app_tenant has no grant on memberships (it reads members through the
--      company_members view). 0002 section 5 gives app_system GRANT ALL on memberships, table-wide, and the
--      team path runs as app_system, so it can already read and write the new column.
--    - messages.to_email and messages.subject: app_tenant's table-wide SELECT, INSERT and UPDATE on messages
--      (0002 section 2) covers them. app_system keeps only its column-level SELECT on messages.
