-- Custom migration (drizzle-kit generate --custom --name messages_from_e164), Task 18 (R24). The
-- schema has the column too (schema/tenant.ts), and 0008_snapshot.json was given it by hand so the
-- next `drizzle-kit generate` finds nothing to add.
--
-- messages.from_e164: the number an inbound text came from (Twilio's `From`). An inbound row keeps
-- the company's texting number it was sent to (`To`) in to_e164; outbound rows leave from_e164 NULL.
-- app_tenant's table-level grants on messages cover the new column; app_system's column-level SELECT
-- (id, company_id, status, scheduled_for) does not, and no fan-out needs it: never content.
ALTER TABLE "messages" ADD COLUMN "from_e164" text;
