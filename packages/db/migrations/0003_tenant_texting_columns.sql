-- Custom migration (drizzle-kit generate --custom): app_tenant may read its texting registration
-- but never the subaccount auth token, not even encrypted. Table-level SELECT from 0002 becomes
-- column-level SELECT on every other column. RLS (tenant_isolation) is unchanged.
--
-- A column added to texting_registrations later is NOT readable by app_tenant until a migration
-- grants it; test/rls.test.ts fails until that decision is made.
REVOKE SELECT ON texting_registrations FROM app_tenant;
--> statement-breakpoint
GRANT SELECT (
  id, company_id, subaccount_sid, brand_sid, brand_status, campaign_sid, campaign_status,
  messaging_service_sid, submitted_at, approved_at, rejection_reason_plain, created_at, updated_at
) ON texting_registrations TO app_tenant;
