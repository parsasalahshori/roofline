-- Custom migration (drizzle-kit generate --custom): app roles, grants, forced row-level security,
-- the company_members view and the pgboss schema. Run by the migration owner.
--
-- Role passwords are NOT set here; run scripts/set-role-passwords.ts after migrating.
-- Tables a later migration adds get no grants by default: grant them explicitly and, for a
-- tenant table, add it to TENANT_TABLES and give it the same ENABLE/FORCE/tenant_isolation block.

-- 1. Roles (cluster-wide, so created only when missing; attributes re-asserted either way).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system LOGIN;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE app_tenant WITH LOGIN NOBYPASSRLS;
--> statement-breakpoint
ALTER ROLE app_system WITH LOGIN BYPASSRLS;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant, app_system;
--> statement-breakpoint

-- 2. app_tenant: tenant tables. No DELETE anywhere except opt_outs (a START keyword removes the
--    row); everything else is archived. audit_log is append-only.
GRANT SELECT, INSERT, UPDATE ON
  company_settings, customers, properties, jobs, activities, integrations, usage_events,
  agent_tasks, agent_task_steps, messages, opt_outs
  TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_log TO app_tenant;
--> statement-breakpoint
GRANT DELETE ON opt_outs TO app_tenant;
--> statement-breakpoint

-- 3. app_tenant: company-scoped global tables, its own company only (RLS below). Billing, slug and
--    texting-registration state are written only by app_system. updated_at is included because
--    Drizzle's $onUpdate sets it on every UPDATE.
GRANT SELECT ON companies, company_phone_numbers, texting_registrations TO app_tenant;
--> statement-breakpoint
GRANT UPDATE (
  name, legal_name, phone_e164, email, website,
  address_street, address_city, address_state, address_zip,
  timezone, service_area, logo_url, updated_at
) ON companies TO app_tenant;
--> statement-breakpoint

-- 4. company_members: the only way app_tenant sees member names. The view runs with its owner's
--    privileges (app_tenant has no grant on memberships or users) and filters to the current
--    company. security_barrier keeps caller-supplied predicates from running before that filter.
CREATE VIEW company_members WITH (security_barrier) AS
  SELECT m.id, m.user_id, u.name, u.email, m.role, m.status
    FROM memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.company_id = nullif(current_setting('app.company_id', true), '')::uuid;
--> statement-breakpoint
GRANT SELECT ON company_members TO app_tenant;
--> statement-breakpoint

-- 5. app_system: BYPASSRLS (above), ALL on the global tables, and only the columns the scheduler
--    fan-out needs from tenant tables (ids, company, status, timing; never content).
GRANT ALL ON
  users, sessions, memberships, invites, companies, company_phone_numbers,
  texting_registrations, webhook_events, user_tokens
  TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, status, expires_at) ON agent_tasks TO app_system;
--> statement-breakpoint
GRANT SELECT (id, task_id, company_id, status, updated_at) ON agent_task_steps TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, status, scheduled_for) ON messages TO app_system;
--> statement-breakpoint

-- 6. pg-boss keeps its queue tables in its own schema, owned by the role it connects as.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_system;
--> statement-breakpoint

-- 7. Row-level security, ENABLED and FORCED (so even a non-superuser table owner is filtered).
--    With app.company_id unset or empty the expression is NULL, so a query returns zero rows
--    instead of erroring, and every write fails WITH CHECK. app_system bypasses RLS but its
--    grants above keep it to global tables and the scheduler columns.
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company_settings
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON customers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE properties FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON properties
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON jobs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE activities FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON activities
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON audit_log
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON integrations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON usage_events
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_tasks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent_tasks
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_task_steps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_task_steps FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON agent_task_steps
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON messages
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE opt_outs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE opt_outs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON opt_outs
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE company_phone_numbers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_phone_numbers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company_phone_numbers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE texting_registrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE texting_registrations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON texting_registrations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
-- companies is keyed by its own id, so its policy compares id instead of company_id.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY company_self ON companies
  USING (id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.company_id', true), '')::uuid);
