-- Custom migration (drizzle-kit generate --custom --name messages_retryable), Task 17 (R7). The
-- schema has the column too (schema/tenant.ts), and 0007_snapshot.json was given it by hand so the
-- next `drizzle-kit generate` finds nothing to add.
--
-- messages.retryable: for a `failed` text, whether trying it again is safe. Only a send the provider
-- refused is retryable (it never went out). A text that may have gone out (queued too long, so it is
-- unconfirmed) or that can never go out (no usable local time) is not, so a retry never sends it.
-- app_tenant's table-level grants on messages cover the new column; app_system's column-level SELECT
-- (id, company_id, status, scheduled_for) does not, and the dispatcher's fan-out does not need it.
ALTER TABLE "messages" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;
