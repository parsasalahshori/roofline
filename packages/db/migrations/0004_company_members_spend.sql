-- Custom migration (drizzle-kit generate --custom): company_members also exposes
-- memberships.can_approve_spend, so the Team page can show who has been delegated spend approval.
--
-- CREATE OR REPLACE VIEW can only APPEND columns, so the new one goes last and the existing six keep
-- their names, types and order. Everything else is exactly as in 0002: the owner's privileges (the
-- view is how app_tenant sees names and emails without any grant on users or memberships), the
-- current-company filter, and security_barrier. Replacing a view keeps its privileges; the GRANT
-- below only restates the one app_tenant already has, so this file stands on its own.
CREATE OR REPLACE VIEW company_members WITH (security_barrier) AS
  SELECT m.id, m.user_id, u.name, u.email, m.role, m.status, m.can_approve_spend
    FROM memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.company_id = nullif(current_setting('app.company_id', true), '')::uuid;
--> statement-breakpoint
GRANT SELECT ON company_members TO app_tenant;
