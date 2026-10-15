CREATE TABLE "window_measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"address" text NOT NULL,
	"center" jsonb NOT NULL,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimated" jsonb,
	"stories" integer,
	"geometry" jsonb,
	"detector" text,
	"missing_reason" text,
	"review_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"adjustments" jsonb DEFAULT '{"excludedWindowIds":[],"manualCounts":{}}'::jsonb NOT NULL,
	"took_ms" integer NOT NULL,
	"photos_delete_by" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "window_measurements_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "window_measurements_detector_check" CHECK ("window_measurements"."detector" in ('claude', 'owlv2', 'stand-in')),
	CONSTRAINT "window_measurements_missing_reason_check" CHECK ("window_measurements"."missing_reason" in ('no-street-view', 'house-blurred', 'facade-hidden', 'no-footprint', 'detector-unconfigured', 'detector-error'))
);
--> statement-breakpoint
ALTER TABLE "window_measurements" ADD CONSTRAINT "window_measurements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_measurements" ADD CONSTRAINT "window_measurements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_measurements" ADD CONSTRAINT "window_measurements_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "window_measurements_property_idx" ON "window_measurements" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "window_measurements_photos_delete_by_idx" ON "window_measurements" USING btree ("photos_delete_by");