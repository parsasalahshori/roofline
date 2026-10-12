CREATE TABLE "building_footprint_states" (
	"state" char(2) PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"buildings" integer,
	"source_url" text,
	"started_at" timestamp with time zone,
	"loaded_at" timestamp with time zone,
	"error_plain" text,
	CONSTRAINT "building_footprint_states_status_check" CHECK ("building_footprint_states"."status" in ('loading', 'ready', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "building_footprints" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"state" char(2) NOT NULL,
	"geom" geometry(Polygon,4326) NOT NULL,
	"area_sq_ft" numeric(12, 1) NOT NULL,
	"source" text NOT NULL,
	"source_ref" text
);
--> statement-breakpoint
CREATE TABLE "exact_report_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"measurement_id" uuid NOT NULL,
	"status" text DEFAULT 'priced' NOT NULL,
	"price_min_cents" integer,
	"price_max_cents" integer,
	"price_expires_at" timestamp with time zone,
	"provider_product_id" text,
	"provider_report_id" text,
	"reference_id" text NOT NULL,
	"task_id" uuid,
	"last_polled_at" timestamp with time zone,
	"error_plain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exact_report_orders_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "exact_report_orders_company_reference_uniq" UNIQUE("company_id","reference_id"),
	CONSTRAINT "exact_report_orders_status_check" CHECK ("exact_report_orders"."status" in ('priced', 'ordering', 'waiting', 'complete', 'attention', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"outline" geometry(MultiPolygon,4326),
	"structures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"footprint_sq_ft" numeric(12, 2),
	"overhang_ft" numeric(4, 2),
	"pitch_x12" numeric(4, 2),
	"surface_sq_ft" numeric(12, 2),
	"edge_ft" numeric(12, 2),
	"ridge_ft" numeric(12, 2),
	"valley_ft" numeric(12, 2),
	"facets" integer,
	"provider_ref" text,
	"notes" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measurements_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "measurements_kind_check" CHECK ("measurements"."kind" in ('estimate', 'exact')),
	CONSTRAINT "measurements_method_check" CHECK ("measurements"."method" in ('outline', 'aerial', 'eagleview', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "proposal_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_counters_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE "proposal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_events_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "proposal_events_kind_check" CHECK ("proposal_events"."kind" in ('sent', 'viewed', 'option_viewed', 'signed', 'declined', 'link_resent', 'link_copied'))
);
--> statement-breakpoint
CREATE TABLE "proposal_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"highlights" text[] DEFAULT '{}' NOT NULL,
	"scope" jsonb NOT NULL,
	"prices" jsonb NOT NULL,
	"add_ons" jsonb NOT NULL,
	"calculation" jsonb NOT NULL,
	"total_cents" integer NOT NULL,
	"monthly_estimate_cents" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_options_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "proposal_options_proposal_tier_uniq" UNIQUE("proposal_id","tier"),
	CONSTRAINT "proposal_options_tier_check" CHECK ("proposal_options"."tier" in ('good', 'better', 'best'))
);
--> statement-breakpoint
CREATE TABLE "proposal_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"signer_name" text NOT NULL,
	"typed_signature" text NOT NULL,
	"drawn_signature_png_sha256" text,
	"consent_text" text NOT NULL,
	"consent_version" text NOT NULL,
	"document_sha256" text NOT NULL,
	"total_cents" integer NOT NULL,
	"ip" text,
	"user_agent" text,
	"signed_at" timestamp with time zone NOT NULL,
	"viewed_first_at" timestamp with time zone,
	"pdf_file_id" uuid,
	"pdf_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposal_signatures_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "proposal_signatures_proposal_uniq" UNIQUE("proposal_id")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"measurement_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"valid_until" date NOT NULL,
	"link_token_hash" "bytea" NOT NULL,
	"link_token_encrypted" "bytea" NOT NULL,
	"sent_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"replaced_by_id" uuid,
	"message_body" text,
	"estimate_basis" text NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "proposals_company_number_uniq" UNIQUE("company_id","number"),
	CONSTRAINT "proposals_link_token_hash_uniq" UNIQUE("link_token_hash"),
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" in ('draft', 'ready', 'sent', 'viewed', 'signed', 'declined', 'expired', 'replaced')),
	CONSTRAINT "proposals_estimate_basis_check" CHECK ("proposals"."estimate_basis" in ('estimate', 'exact'))
);
--> statement-breakpoint
CREATE TABLE "stored_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_files_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "stored_files_kind_check" CHECK ("stored_files"."kind" in ('signed_proposal_pdf'))
);
--> statement-breakpoint
CREATE TABLE "tier_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"name" text NOT NULL,
	"material" text NOT NULL,
	"waste_percent" numeric(5, 2) DEFAULT 12 NOT NULL,
	"markup_percent" numeric(5, 2),
	"add_ons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"highlights" text[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tier_templates_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "tier_templates_company_tier_uniq" UNIQUE("company_id","tier"),
	CONSTRAINT "tier_templates_highlights_check" CHECK (cardinality("tier_templates"."highlights") <= 4),
	CONSTRAINT "tier_templates_tier_check" CHECK ("tier_templates"."tier" in ('good', 'better', 'best')),
	CONSTRAINT "tier_templates_material_check" CHECK ("tier_templates"."material" in ('architectural', 'premium', 'metal'))
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "default_pitch_x12" numeric(4, 2) DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "overhang_ft" numeric(3, 1) DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "proposal_valid_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "aerial_measure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "estimate_change_clause" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "exact_report_orders" ADD CONSTRAINT "exact_report_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exact_report_orders" ADD CONSTRAINT "exact_report_orders_company_measurement_fk" FOREIGN KEY ("company_id","measurement_id") REFERENCES "public"."measurements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exact_report_orders" ADD CONSTRAINT "exact_report_orders_company_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."agent_tasks"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "measurements" ADD CONSTRAINT "measurements_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_counters" ADD CONSTRAINT "proposal_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_company_proposal_fk" FOREIGN KEY ("company_id","proposal_id") REFERENCES "public"."proposals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_options" ADD CONSTRAINT "proposal_options_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_options" ADD CONSTRAINT "proposal_options_company_proposal_fk" FOREIGN KEY ("company_id","proposal_id") REFERENCES "public"."proposals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_company_proposal_fk" FOREIGN KEY ("company_id","proposal_id") REFERENCES "public"."proposals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_company_option_fk" FOREIGN KEY ("company_id","option_id") REFERENCES "public"."proposal_options"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposal_signatures" ADD CONSTRAINT "proposal_signatures_company_pdf_fk" FOREIGN KEY ("company_id","pdf_file_id") REFERENCES "public"."stored_files"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_measurement_fk" FOREIGN KEY ("company_id","measurement_id") REFERENCES "public"."measurements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_company_replaced_by_fk" FOREIGN KEY ("company_id","replaced_by_id") REFERENCES "public"."proposals"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tier_templates" ADD CONSTRAINT "tier_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "building_footprints_geom_gist" ON "building_footprints" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "building_footprints_state_idx" ON "building_footprints" USING btree ("state");--> statement-breakpoint
CREATE INDEX "measurements_property_idx" ON "measurements" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "proposal_events_proposal_at_idx" ON "proposal_events" USING btree ("proposal_id","at");--> statement-breakpoint
CREATE INDEX "proposals_job_idx" ON "proposals" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "proposals_status_idx" ON "proposals" USING btree ("status");--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_default_pitch_x12_check" CHECK ("company_settings"."default_pitch_x12" between 0 and 24);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_overhang_ft_check" CHECK ("company_settings"."overhang_ft" between 0 and 3);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_proposal_valid_days_check" CHECK ("company_settings"."proposal_valid_days" between 1 and 180);