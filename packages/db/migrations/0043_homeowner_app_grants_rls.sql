-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the homeowner app's requests
-- (0042_homeowner_app.sql). Run by the migration owner.
--
-- A table a later migration adds gets no grants by default (see 0002): every grant below is deliberate, and
-- test/rls.test.ts lists them.

-- 1. app_tenant: read, write and change the company's homeowner requests. No DELETE: a request is the record of what a
--    homeowner was shown and told, and its token hash is the proof of who may open it. The signed-out public routes
--    run on the tenant pool inside withTenant for the company the slug names (the way the instant quote page does), so
--    app_system gets nothing on this table.
GRANT SELECT, INSERT, UPDATE ON homeowner_requests TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security, ENABLED and FORCED, with the same tenant_isolation policy as every other tenant table.
ALTER TABLE homeowner_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE homeowner_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON homeowner_requests
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
