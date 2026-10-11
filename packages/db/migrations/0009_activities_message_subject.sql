-- Generated (`drizzle-kit generate --name activities_message_subject`), Task 18 fix round 1 (I2), so
-- 0009_snapshot.json stays accurate. activities.subject_type gains 'message': a text from a number that
-- is no customer's and reads like an opt-out is flagged on the message's own timeline for a person to
-- check. app_tenant's grants on activities are unchanged.
ALTER TABLE "activities" DROP CONSTRAINT "activities_subject_type_check";--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_subject_type_check" CHECK ("activities"."subject_type" in ('customer', 'property', 'job', 'message'));