-- Custom migration (drizzle-kit generate --custom): grants and row-level security for window_orders, which
-- 0036_window_orders_schema.sql added. Run by the migration owner.
--
-- A table a later migration adds gets no grants by default (see 0002): every grant below is deliberate, and
-- test/rls.test.ts lists them.

-- 1. app_tenant: read, write and change window factory orders. No DELETE: an order is kept (what was sent to the
--    factory, and who sent it). A ready order is reopened by changing its status, never deleted.
GRANT SELECT, INSERT, UPDATE ON window_orders TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security, ENABLED and FORCED, with the same tenant_isolation policy as every other tenant table.
ALTER TABLE window_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE window_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON window_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);

-- 3. company_settings.window_order_settings: 0002 section 2 grants app_tenant table-wide SELECT, INSERT and UPDATE on
--    company_settings, and no later migration restricts that by column, so the new column needs no grant here.

-- 4. app_system: no grant and no policy. Nothing outside a tenant's own requests reads window orders.
