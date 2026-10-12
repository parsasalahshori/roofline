-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the E1 tables that
-- 0015_estimator_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the nine E1 tenant tables. No DELETE on any of them: rows are never deleted. A
--    proposal is replaced or expired (its status changes, the row stays), tier templates are edited in
--    place, and measurements, options, signatures, events, stored files and report orders are kept.
GRANT SELECT, INSERT, UPDATE ON
  measurements, tier_templates, proposals, proposal_counters, proposal_options,
  proposal_events, exact_report_orders, stored_files
  TO app_tenant;
--> statement-breakpoint
-- A signature is never edited (Review Focus 2, Ruling EQ): app_tenant may insert it and later attach the
-- signed PDF, nothing else. The UPDATE grant is limited to the three columns that attaching writes.
GRANT SELECT, INSERT ON proposal_signatures TO app_tenant;
--> statement-breakpoint
GRANT UPDATE (pdf_file_id, pdf_sha256, updated_at) ON proposal_signatures TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the nine new tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE measurements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE measurements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON measurements
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE tier_templates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tier_templates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tier_templates
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposals
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposal_counters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposal_counters FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposal_counters
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposal_options ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposal_options FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposal_options
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposal_signatures ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposal_signatures FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposal_signatures
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE proposal_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE proposal_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON proposal_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE exact_report_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE exact_report_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON exact_report_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE stored_files ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE stored_files FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stored_files
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 3. Global footprint tables: no company_id and no RLS (they hold no tenant data, Ruling EA). app_tenant
--    reads building_footprints only, to show a property's footprint; it cannot write either table, and
--    building_footprint_states (the loader's progress) is app_system's alone. Writes come from the loader
--    job, which runs as app_system.
GRANT SELECT ON building_footprints TO app_tenant;
--> statement-breakpoint
GRANT ALL ON building_footprints, building_footprint_states TO app_system;
--> statement-breakpoint
-- building_footprints.id is a bigserial, so the loader's inserts need USAGE on its sequence. Nothing
-- else grants sequence access: 0002 sets no ALTER DEFAULT PRIVILEGES, and no earlier table has a serial
-- column, so this grant is the only one a sequence gets. app_tenant never inserts, so it gets none.
GRANT USAGE, SELECT ON SEQUENCE building_footprints_id_seq TO app_system;
--> statement-breakpoint

-- 4. company_settings: the five new columns (default_pitch_x12, overhang_ft, proposal_valid_days,
--    aerial_measure, estimate_change_clause) need no column-level grant. 0002 section 2 already grants
--    app_tenant table-wide SELECT, INSERT and UPDATE on company_settings, and no later migration revokes
--    or restricts those grants by column, so the new columns are readable and writable as they are.
--    A column-level grant here would be redundant, so none is added.

-- 5. app_system: the homeowner API resolves a token hash to {companyId, proposalId} from proposals, and
--    the exact-report fan-out reads only the status and last_polled_at of exact_report_orders. The
--    column grants are the real limit. The app_system_all policies below let every row through on these
--    two tables (app_system is not RLS-exempt), so the column list alone decides what app_system can see:
--    no proposal content, signatures, stored files or other report columns.
GRANT SELECT (id, company_id, link_token_hash, status, valid_until) ON proposals TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON proposals FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT (id, company_id, status, last_polled_at) ON exact_report_orders TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON exact_report_orders FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint

-- 6. Ruling EQ (whole-branch review): a proposal's options change only while the proposal is a draft. A sent,
--    signed or replaced proposal's prices are what the customer saw; the database refuses to rewrite them
--    even if application code tried. SECURITY INVOKER: the lookup runs as the caller, under RLS.
CREATE FUNCTION proposal_options_draft_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM proposals WHERE id = OLD.proposal_id AND company_id = OLD.company_id) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'proposal options can change only while the proposal is a draft' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER proposal_options_draft_only BEFORE UPDATE ON proposal_options
  FOR EACH ROW EXECUTE FUNCTION proposal_options_draft_only();
--> statement-breakpoint

-- 7. The exact-report poll reads waiting orders by last_polled_at every 10 minutes (Ruling EQ).
CREATE INDEX exact_report_orders_waiting_polled_idx ON exact_report_orders (last_polled_at) WHERE status = 'waiting';
