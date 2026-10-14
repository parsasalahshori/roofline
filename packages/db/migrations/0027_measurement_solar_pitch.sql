ALTER TABLE "measurements" ADD COLUMN "pitch_source" text;--> statement-breakpoint
ALTER TABLE "measurements" ADD COLUMN "pitch_planes" jsonb;--> statement-breakpoint
ALTER TABLE "measurements" ADD COLUMN "solar" jsonb;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_pitch_source_check" CHECK ("measurements"."pitch_source" in ('solar', 'default', 'manual'));