CREATE TABLE "quote_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"input_key" text NOT NULL,
	"address_key" text,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"measured" boolean DEFAULT false NOT NULL,
	"property_id" uuid,
	"measurement_id" uuid,
	"result" jsonb NOT NULL,
	"ip_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_estimates_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "quote_estimates_status_check" CHECK ("quote_estimates"."status" in ('ready', 'fallback'))
);
--> statement-breakpoint
CREATE TABLE "quote_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"quote_estimate_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone_e164" text NOT NULL,
	"postal_code" text NOT NULL,
	"products" text[] NOT NULL,
	"consent_text" text NOT NULL,
	"consent_version" text NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"ip_hash" text,
	"customer_id" uuid,
	"job_id" uuid,
	"appointment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_requests_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "quote_requests_products_check" CHECK ("quote_requests"."products" <@ array['windows','roof','gutters']::text[])
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_slug" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_products" text[] DEFAULT '{windows,roof}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_range_pct" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_daily_cap" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_embed_origins" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_booking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "quote_accent_color" text;--> statement-breakpoint
ALTER TABLE "quote_estimates" ADD CONSTRAINT "quote_estimates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_estimates" ADD CONSTRAINT "quote_estimates_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_estimates" ADD CONSTRAINT "quote_estimates_company_measurement_fk" FOREIGN KEY ("company_id","measurement_id") REFERENCES "public"."measurements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_estimate_fk" FOREIGN KEY ("company_id","quote_estimate_id") REFERENCES "public"."quote_estimates"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_requests" ADD CONSTRAINT "quote_requests_company_appointment_fk" FOREIGN KEY ("company_id","appointment_id") REFERENCES "public"."appointments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_estimates_company_input_idx" ON "quote_estimates" USING btree ("company_id","input_key");--> statement-breakpoint
CREATE INDEX "quote_estimates_company_address_idx" ON "quote_estimates" USING btree ("company_id","address_key");--> statement-breakpoint
CREATE INDEX "quote_estimates_company_created_idx" ON "quote_estimates" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "quote_requests_company_created_idx" ON "quote_requests" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_slug_uniq" UNIQUE("quote_slug");--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_slug_check" CHECK ("company_settings"."quote_slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$');--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_products_check" CHECK ("company_settings"."quote_products" <@ array['windows','roof','gutters']::text[]);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_range_pct_check" CHECK ("company_settings"."quote_range_pct" between 5 and 40);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_daily_cap_check" CHECK ("company_settings"."quote_daily_cap" between 0 and 1000);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_embed_origins_check" CHECK (cardinality("company_settings"."quote_embed_origins") <= 10);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_quote_accent_color_check" CHECK ("company_settings"."quote_accent_color" ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$');