-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the instant quote page
-- (0034_instant_quote_schema.sql). Run by the migration owner.
--
-- A table a later migration adds gets no grants by default (see 0002): every grant below is deliberate, and
-- test/rls.test.ts lists them.

-- 1. app_tenant: read, write and change quote estimates and quote requests for its own company. No DELETE: an
--    estimate is the record of what a homeowner was shown, and a request carries their consent evidence.
GRANT SELECT, INSERT, UPDATE ON quote_estimates TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON quote_requests TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security, ENABLED and FORCED, with the same tenant_isolation policy as every other tenant table.
ALTER TABLE quote_estimates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE quote_estimates FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON quote_estimates
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE quote_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE quote_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON quote_requests
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 3. app_system: the public page finds its company by slug before any tenant transaction exists. It may read only
--    three columns of company_settings (company_id, quote_slug, quote_enabled) and nothing else of the table; the
--    column grant is the real limit, and app_system_all lets it through RLS like every other table it holds a grant
--    on (0002 section 8). company_settings' new quote_* columns need nothing for app_tenant: 0002 section 2 grants it
--    table-wide SELECT, INSERT and UPDATE. quote_estimates and quote_requests: no app_system grant at all.
GRANT SELECT (company_id, quote_slug, quote_enabled) ON company_settings TO app_system;
--> statement-breakpoint
CREATE POLICY app_system_all ON company_settings FOR ALL TO app_system USING (true) WITH CHECK (true);
