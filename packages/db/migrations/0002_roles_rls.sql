-- Custom migration (drizzle-kit generate --custom): app roles, grants, forced row-level security,
-- the company_members view and the pgboss schema. Run by the migration owner.
--
-- Role passwords are NOT set here; run scripts/set-role-passwords.ts after migrating.
-- Tables a later migration adds get no grants by default: grant them explicitly and, for a
-- tenant table, add it to TENANT_TABLES and give it the same ENABLE/FORCE/tenant_isolation block.

-- 1. Roles (cluster-wide, so created only when missing; attributes re-asserted either way).
--    Neither role bypasses row-level security. Granting the bypass needs a superuser (PostgreSQL 15)
--    or an owner that has it itself (16+), and a managed host (Supabase) gives the migration owner
--    CREATEROLE but no superuser, so app_system gets through RLS with its app_system_all policies
--    (section 8) instead. The migration owner needs only CREATEROLE here.
--
--    PostgreSQL refuses any ALTER ROLE that names the attribute, even NOBYPASSRLS, from an owner
--    that is not a superuser (15) or lacks the attribute (16+), so it is only taken off a role that
--    has it (left over from an earlier run). CREATE ROLE ... NOBYPASSRLS needs only CREATEROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system LOGIN NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant' AND rolbypassrls) THEN
    ALTER ROLE app_tenant NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system' AND rolbypassrls) THEN
    ALTER ROLE app_system NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE app_tenant WITH LOGIN;
--> statement-breakpoint
ALTER ROLE app_system WITH LOGIN;
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

-- 5. app_system: on the global tables, only the privileges its code uses (never TRUNCATE, which
--    skips RLS, nor TRIGGER or REFERENCES); and only the columns the scheduler fan-out needs from
--    tenant tables (ids, company, status, timing; never content). These grants are its real limit:
--    its RLS policies (section 8) let every row through on the tables granted here.
--    - accounts, sign-in and team (users, sessions, memberships, invites, user_tokens) and
--      companies (sign-up rollback deletes the new company): read, add, change, remove;
--    - texting_registrations: read, add, change (a registration is never deleted);
--    - company_phone_numbers: read, add (the main number; insert ... on conflict do nothing);
--    - webhook_events: read, add (the Stripe event claim, insert ... returning id).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, memberships, invites, companies, user_tokens
  TO app_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON texting_registrations TO app_system;
--> statement-breakpoint
GRANT SELECT, INSERT ON company_phone_numbers, webhook_events TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, status, expires_at) ON agent_tasks TO app_system;
--> statement-breakpoint
GRANT SELECT (id, task_id, company_id, status, updated_at) ON agent_task_steps TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, status, scheduled_for) ON messages TO app_system;
--> statement-breakpoint

-- 6. pg-boss keeps its queue tables in its own schema, owned by the role it connects as.
--    AUTHORIZATION needs the right to SET ROLE app_system (PostgreSQL 15: membership). A superuser
--    has it; a CREATEROLE owner that is not one (a managed host) does not, even for a role it made,
--    so it grants itself app_system for this one statement and revokes it straight after. The owner
--    is named rather than written CURRENT_USER: Supabase's Postgres 17 crashes on
--    `GRANT ... TO CURRENT_USER`.
DO $$
BEGIN
  CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_system;
EXCEPTION WHEN insufficient_privilege THEN
  EXECUTE format('GRANT app_system TO %I', current_user);
  CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION app_system;
  EXECUTE format('REVOKE app_system FROM %I', current_user);
END
$$;
--> statement-breakpoint

-- 7. Row-level security, ENABLED and FORCED (so even a non-superuser table owner is filtered).
--    With app.company_id unset or empty the expression is NULL, so a query returns zero rows
--    instead of erroring, and every write fails WITH CHECK. The tenant_isolation and company_self
--    policies apply to every role (TO public); app_system also has app_system_all (section 8).
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
--> statement-breakpoint

-- 8. app_system through row-level security: one permissive policy on every RLS table it holds a grant
--    on (sections 3 and 5; later migrations only add columns to those grants). Permissive policies
--    are OR-ed, so app_system sees and writes every company's rows there, with or without
--    app.company_id; app_tenant is still held to tenant_isolation/company_self. The grants stay the
--    real limit: on agent_tasks, agent_task_steps and messages app_system may read only the
--    scheduler columns, and it has no grant at all on the other tenant tables. A migration that
--    grants app_system another RLS table must add the same policy (test/rls.test.ts checks).
CREATE POLICY app_system_all ON companies FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON company_phone_numbers FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON texting_registrations FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON agent_tasks FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON agent_task_steps FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON messages FOR ALL TO app_system USING (true) WITH CHECK (true);
