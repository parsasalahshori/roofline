-- D1: Front Desk grants and RLS (custom; Ruling AP numbering 0020)
--
-- Custom migration (drizzle-kit generate --custom): grants and row-level security for the D1 tables
-- that 0019_front_desk_schema.sql added. Run by the migration owner.
--
-- A table or column a later migration adds gets no grants by default (see 0002): every grant below is
-- deliberate, and test/rls.test.ts lists them.

-- 1. app_tenant: the five new tenant tables. conversation_turns is the transcript, so it has no
--    DELETE and no table-level UPDATE: only the columns the retention sweep and corrections need.
--    blocked_numbers is the only tenant table with DELETE (a number unblocked by its owner).
GRANT SELECT, INSERT, UPDATE ON conversations, calls, claim_intakes TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON conversation_turns TO app_tenant;
--> statement-breakpoint
GRANT UPDATE (text, tool_calls, truncated) ON conversation_turns TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_numbers TO app_tenant;
--> statement-breakpoint

-- 2. Row-level security on the new tenant tables, ENABLED and FORCED, with the same tenant_isolation
--    policy as every other tenant table (0002 section 7).
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversations
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE calls FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON calls
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON conversation_turns
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE claim_intakes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE claim_intakes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON claim_intakes
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE blocked_numbers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE blocked_numbers FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON blocked_numbers
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
--> statement-breakpoint

-- 3. Existing tables that gain D1 columns. company_settings (the front desk settings), appointments
--    (confirmed_at, confirmed_via) and messages (conversation_id) already have table-wide SELECT,
--    INSERT and UPDATE for app_tenant from 0002 and 0014, so the new columns are writable and readable
--    with no column-level grant; a column-level grant here would be redundant, so none is added.
--    memberships is a global table with no app_tenant grant at all (its tenant view is company_members),
--    so transfer_phone_e164, on_call_order and recording_ack_at are written only by app_system. A
--    tenant grant on memberships would reach other companies' rows, since memberships has no RLS.

-- 4. app_system: the recording and retention fan-outs read only the ids, company, status and recording
--    columns they need, across companies, through the app_system_all policies below (section 6). These
--    grants are its real limit. It may write only the recording columns of a call. It never reads or
--    writes transcript text or tool records (Ruling BF): the retention sweep blanks turns on the tenant
--    pool, inside withTenant.
GRANT SELECT (id, company_id, call_sid, status, conversation_id, recording_key, recording_status) ON calls TO app_system;
--> statement-breakpoint
GRANT UPDATE (recording_key, recording_status) ON calls TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, status) ON conversations TO app_system;
--> statement-breakpoint
GRANT SELECT (id, company_id, at) ON conversation_turns TO app_system;
--> statement-breakpoint
-- fd-health marks a number whose voice URL it set by appending a marker to company_phone_numbers.capabilities
-- (markVoiceUrlSet). C1's Ruling SEC-4 left app_system only SELECT and INSERT on that table, so it gets UPDATE on
-- that one column and nothing else.
GRANT UPDATE (capabilities) ON company_phone_numbers TO app_system;
--> statement-breakpoint

-- 5. Global lookup cache for the line type (Twilio Lookup). It has no company_id and no RLS: a line's
--    type is not a customer's data, and the cache is shared across companies.
GRANT SELECT, INSERT, UPDATE ON line_lookups TO app_system;
--> statement-breakpoint
GRANT SELECT ON line_lookups TO app_tenant;
--> statement-breakpoint

-- 6. app_system_all: app_system holds grants on these RLS tables, so each needs the permissive policy
--    (a table it holds a grant on with no policy would silently return zero rows).
CREATE POLICY app_system_all ON calls FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON conversations FOR ALL TO app_system USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY app_system_all ON conversation_turns FOR ALL TO app_system USING (true) WITH CHECK (true);
