ALTER TABLE "measurements" DROP CONSTRAINT "measurements_pitch_source_check";--> statement-breakpoint
ALTER TABLE "measurements" ADD COLUMN "roof_3d" jsonb;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_pitch_source_check" CHECK ("measurements"."pitch_source" in ('solar', 'default', 'manual', 'solar-3d'));