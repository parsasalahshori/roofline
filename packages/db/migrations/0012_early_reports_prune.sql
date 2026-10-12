-- Custom migration (drizzle-kit generate --custom): lets the scheduler prune stale early delivery
-- reports. Run by the migration owner.
--
-- app_system prunes stale unapplied early_delivery_reports across companies (the daily
-- prune-early-reports job). It reads only the three columns the prune needs (id, received_at,
-- applied_at) and may delete rows; it never reads or changes a report's status or reason. The
-- policy is required because the table forces RLS, so app_system needs an app_system_all policy
-- to see or delete rows of every company, as usage_events does in 0011.

-- 1. app_system: read the prune's columns, and delete.
GRANT SELECT (id, received_at, applied_at), DELETE ON early_delivery_reports TO app_system;
--> statement-breakpoint

-- 2. The policy that lets app_system see and delete rows of every company.
CREATE POLICY app_system_all ON early_delivery_reports FOR ALL TO app_system USING (true) WITH CHECK (true);
