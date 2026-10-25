-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the WinChoice back office tables
-- (0047_backoffice.sql). Run by the migration owner.
--
-- A table a later migration adds gets no grants by default (see 0002): every grant below is deliberate, and
-- test/rls.test.ts lists them.

-- 1. app_tenant: quotes and orders are read, written and changed, never deleted (a quote is the record of what the
--    customer was shown; an order is the record of what was sold). The order events are the timeline: append-only, so
--    SELECT and INSERT only. app_system gets nothing: only the company's own signed-in routes touch these.
GRANT SELECT, INSERT, UPDATE ON backoffice_quotes TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON backoffice_orders TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON backoffice_order_events TO app_tenant;
--> statement-breakpoint
-- The one column a later write sets: how the customer was told (the send happens after the move is saved, so its
-- result is written onto the same event). Nothing else on an event can ever change.
GRANT UPDATE (notified) ON backoffice_order_events TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security, ENABLED and FORCED, with the same tenant_isolation policy as every other tenant table.
ALTER TABLE backoffice_quotes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE backoffice_quotes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backoffice_quotes
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE backoffice_orders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE backoffice_orders FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backoffice_orders
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE backoffice_order_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE backoffice_order_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON backoffice_order_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
