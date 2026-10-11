-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the F3 tables and
-- columns that 0010_f3_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the four new tenant tables. No DELETE: setup items, imports, import rows and early
--    delivery reports are kept.
GRANT SELECT, INSERT, UPDATE ON setup_items, imports, import_rows, early_delivery_reports TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the new tables, ENABLED and FORCED, with the same tenant_isolation policy
--    as every other tenant table (0002 section 7).
ALTER TABLE setup_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE setup_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON setup_items
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE imports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON imports
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON import_rows
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE early_delivery_reports ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE early_delivery_reports FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON early_delivery_reports
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 3. companies: app_tenant may set where the company works from and how far it travels. The billing
--    columns stay writable by app_system only.
GRANT UPDATE (location, service_area_miles) ON companies TO app_tenant;
--> statement-breakpoint

-- 4. texting_registrations: app_tenant may read the new progress columns (never the subaccount auth
--    token, which 0003 keeps out of reach).
GRANT SELECT (customer_profile_sid, trust_product_sid, brand_info, rejected_fields, last_checked_at) ON texting_registrations TO app_tenant;
--> statement-breakpoint

-- 5. usage_events: app_system reads only what the usage reporting fan-out needs, across companies,
--    through an app_system_all policy (a migration that grants app_system an RLS table must add it).
GRANT SELECT (id, company_id, kind, reported_to_stripe_at) ON usage_events TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON usage_events FOR ALL TO app_system USING (true) WITH CHECK (true);
