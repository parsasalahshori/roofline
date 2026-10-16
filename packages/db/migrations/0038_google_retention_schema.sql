CREATE TABLE "google_retention_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"retention_days" integer NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_plain" text
);
--> statement-breakpoint
ALTER TABLE "measurements" ADD COLUMN "google_delete_by" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "measurements_google_delete_by_idx" ON "measurements" USING btree ("google_delete_by");