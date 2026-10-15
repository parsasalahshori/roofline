-- Custom migration (drizzle-kit generate --custom): grants and row-level security for window_measurements, which
-- 0030_window_measurements_schema.sql added. Run by the migration owner.
--
-- A table a later migration adds gets no grants by default (see 0002): every grant below is deliberate, and
-- test/rls.test.ts lists them.

-- 1. app_tenant: read, write and change window measurements. No DELETE: rows are kept (a person's marked windows and
--    the quote they priced). Google's photo bytes live in the object store, not here, and go by photos_delete_by.
GRANT SELECT, INSERT, UPDATE ON window_measurements TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security, ENABLED and FORCED, with the same tenant_isolation policy as every other tenant table.
ALTER TABLE window_measurements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE window_measurements FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON window_measurements
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- 3. app_system: no grant and no policy. Nothing outside a tenant's own requests reads window measurements.
