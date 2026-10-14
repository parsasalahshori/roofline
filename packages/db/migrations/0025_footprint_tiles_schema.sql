CREATE TABLE "building_footprint_tiles" (
	"quadkey" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"buildings" integer,
	"source_url" text,
	"started_at" timestamp with time zone,
	"loaded_at" timestamp with time zone,
	"error_plain" text,
	CONSTRAINT "building_footprint_tiles_status_check" CHECK ("building_footprint_tiles"."status" in ('loading', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "building_footprints" ALTER COLUMN "state" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "building_footprints" ADD COLUMN "tile" text;--> statement-breakpoint
CREATE INDEX "building_footprints_tile_idx" ON "building_footprints" USING btree ("tile");