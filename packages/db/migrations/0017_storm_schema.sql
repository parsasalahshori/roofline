CREATE TABLE "hail_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"valid_at" timestamp with time zone NOT NULL,
	"convective_day" date NOT NULL,
	"status" text NOT NULL,
	"max_in" numeric(4, 2),
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_plain" text,
	CONSTRAINT "hail_runs_source_key_unique" UNIQUE("source_key"),
	CONSTRAINT "hail_runs_status_check" CHECK ("hail_runs"."status" in ('processed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "spotter_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_date" date NOT NULL,
	"time_utc" time NOT NULL,
	"size_in" numeric(4, 2) NOT NULL,
	"location" text,
	"county" text,
	"state" char(2) NOT NULL,
	"geom" geometry(Point,4326) NOT NULL,
	CONSTRAINT "spotter_reports_report_time_geom_uniq" UNIQUE("report_date","time_utc","geom")
);
--> statement-breakpoint
CREATE TABLE "storm_contours" (
	"storm_id" uuid NOT NULL,
	"threshold_in" numeric(4, 2) NOT NULL,
	"geom" geometry(MultiPolygon,4326) NOT NULL,
	CONSTRAINT "storm_contours_pk" PRIMARY KEY("storm_id","threshold_in")
);
--> statement-breakpoint
CREATE TABLE "storms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"convective_day" date NOT NULL,
	"status" text DEFAULT 'provisional' NOT NULL,
	"max_in" numeric(4, 2) NOT NULL,
	"geom_075" geometry(MultiPolygon,4326) NOT NULL,
	"bbox" geometry(Polygon,4326) NOT NULL,
	"centroid" geometry(Point,4326) NOT NULL,
	"place_name" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_grew_at" timestamp with time zone DEFAULT now() NOT NULL,
	"final_at" timestamp with time zone,
	CONSTRAINT "storms_status_check" CHECK ("storms"."status" in ('provisional', 'final'))
);
--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_account_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"name" text,
	"currency" text,
	"linked_at" timestamp with time zone,
	"last_error_plain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "ad_accounts_company_platform_uniq" UNIQUE("company_id","platform"),
	CONSTRAINT "ad_accounts_platform_check" CHECK ("ad_accounts"."platform" in ('google', 'meta')),
	CONSTRAINT "ad_accounts_status_check" CHECK ("ad_accounts"."status" in ('pending', 'active', 'error', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_storm_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"external_campaign_id" text,
	"status" text DEFAULT 'creating' NOT NULL,
	"daily_budget_cents" integer NOT NULL,
	"days" integer NOT NULL,
	"max_spend_cents" integer NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"landing_requests" integer DEFAULT 0 NOT NULL,
	"targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"creative" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"housing_fallback" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"error_kind" text,
	"error_plain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_campaigns_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "ad_campaigns_company_step_uniq" UNIQUE("company_id","step_id"),
	CONSTRAINT "ad_campaigns_platform_check" CHECK ("ad_campaigns"."platform" in ('google', 'meta')),
	CONSTRAINT "ad_campaigns_status_check" CHECK ("ad_campaigns"."status" in ('creating', 'paused', 'active', 'ended', 'failed')),
	CONSTRAINT "ad_campaigns_error_kind_check" CHECK ("ad_campaigns"."error_kind" in ('policy', 'payment', 'access', 'targeting', 'other'))
);
--> statement-breakpoint
CREATE TABLE "company_storms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storm_id" uuid NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"max_in" numeric(4, 2) NOT NULL,
	"customers_hit" integer DEFAULT 0 NOT NULL,
	"homes_hit" integer DEFAULT 0 NOT NULL,
	"alerted_at" timestamp with time zone,
	"plan_task_id" uuid,
	"last_matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_storms_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "company_storms_company_storm_uniq" UNIQUE("company_id","storm_id"),
	CONSTRAINT "company_storms_status_check" CHECK ("company_storms"."status" in ('new', 'planned', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "door_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"footprint_id" bigint NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "door_exclusions_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "door_exclusions_company_footprint_uniq" UNIQUE("company_id","footprint_id")
);
--> statement-breakpoint
CREATE TABLE "door_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_storm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"stops" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "door_routes_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "door_routes_status_check" CHECK ("door_routes"."status" in ('ready', 'in_progress', 'done'))
);
--> statement-breakpoint
CREATE TABLE "door_stops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"route_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"footprint_id" bigint,
	"property_id" uuid,
	"point" geometry(Point,4326) NOT NULL,
	"address" text,
	"hail_in" numeric(4, 2),
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"outcome_by" uuid,
	"created_customer_id" uuid,
	"created_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "door_stops_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "door_stops_route_position_uniq" UNIQUE("route_id","position"),
	CONSTRAINT "door_stops_outcome_check" CHECK ("door_stops"."outcome" in ('not_home', 'wants_check', 'not_interested', 'has_roofer', 'do_not_knock'))
);
--> statement-breakpoint
CREATE TABLE "email_opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"source" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_opt_outs_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "email_opt_outs_company_email_uniq" UNIQUE("company_id","email"),
	CONSTRAINT "email_opt_outs_source_check" CHECK ("email_opt_outs"."source" in ('link', 'one_click', 'complaint', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "storm_hits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_storm_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"customer_id" uuid,
	"hail_in" numeric(4, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storm_hits_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "storm_hits_storm_property_uniq" UNIQUE("company_storm_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "storm_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"company_storm_id" uuid NOT NULL,
	"code" text NOT NULL,
	"active_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storm_pages_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "storm_pages_code_uniq" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "storm_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"stored_file_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storm_photos_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "storm_photos_company_stored_file_uniq" UNIQUE("company_id","stored_file_id")
);
--> statement-breakpoint
CREATE TABLE "storm_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"storm_page_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text NOT NULL,
	"address" text NOT NULL,
	"sms_consent" boolean DEFAULT false NOT NULL,
	"consent_text" text,
	"consent_at" timestamp with time zone,
	"customer_id" uuid,
	"job_id" uuid,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storm_requests_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "storm_requests_page_phone_uniq" UNIQUE("storm_page_id","phone_e164")
);
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_sms_consent_source_check";--> statement-breakpoint
ALTER TABLE "stored_files" DROP CONSTRAINT "stored_files_kind_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "storm_alert_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_ad_budget_cents" integer DEFAULT 27000 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_ad_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_ad_google_share_pct" integer DEFAULT 55 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_email_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_sms_template" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_email_subject" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "storm_email_template" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "to_email" "citext";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "storm_contours" ADD CONSTRAINT "storm_contours_storm_id_storms_id_fk" FOREIGN KEY ("storm_id") REFERENCES "public"."storms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_company_company_storm_fk" FOREIGN KEY ("company_id","company_storm_id") REFERENCES "public"."company_storms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_company_step_fk" FOREIGN KEY ("company_id","step_id") REFERENCES "public"."agent_task_steps"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_storms" ADD CONSTRAINT "company_storms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_storms" ADD CONSTRAINT "company_storms_storm_id_storms_id_fk" FOREIGN KEY ("storm_id") REFERENCES "public"."storms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_storms" ADD CONSTRAINT "company_storms_company_plan_task_fk" FOREIGN KEY ("company_id","plan_task_id") REFERENCES "public"."agent_tasks"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_exclusions" ADD CONSTRAINT "door_exclusions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_routes" ADD CONSTRAINT "door_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_routes" ADD CONSTRAINT "door_routes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_routes" ADD CONSTRAINT "door_routes_company_company_storm_fk" FOREIGN KEY ("company_id","company_storm_id") REFERENCES "public"."company_storms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_outcome_by_users_id_fk" FOREIGN KEY ("outcome_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_company_route_fk" FOREIGN KEY ("company_id","route_id") REFERENCES "public"."door_routes"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_company_created_customer_fk" FOREIGN KEY ("company_id","created_customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_stops" ADD CONSTRAINT "door_stops_company_created_job_fk" FOREIGN KEY ("company_id","created_job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_opt_outs" ADD CONSTRAINT "email_opt_outs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_hits" ADD CONSTRAINT "storm_hits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_hits" ADD CONSTRAINT "storm_hits_company_company_storm_fk" FOREIGN KEY ("company_id","company_storm_id") REFERENCES "public"."company_storms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_hits" ADD CONSTRAINT "storm_hits_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_hits" ADD CONSTRAINT "storm_hits_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_pages" ADD CONSTRAINT "storm_pages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_pages" ADD CONSTRAINT "storm_pages_company_company_storm_fk" FOREIGN KEY ("company_id","company_storm_id") REFERENCES "public"."company_storms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_photos" ADD CONSTRAINT "storm_photos_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_photos" ADD CONSTRAINT "storm_photos_company_stored_file_fk" FOREIGN KEY ("company_id","stored_file_id") REFERENCES "public"."stored_files"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_requests" ADD CONSTRAINT "storm_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_requests" ADD CONSTRAINT "storm_requests_company_storm_page_fk" FOREIGN KEY ("company_id","storm_page_id") REFERENCES "public"."storm_pages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_requests" ADD CONSTRAINT "storm_requests_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storm_requests" ADD CONSTRAINT "storm_requests_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hail_runs_convective_day_idx" ON "hail_runs" USING btree ("convective_day");--> statement-breakpoint
CREATE INDEX "spotter_reports_geom_gist" ON "spotter_reports" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "storm_contours_geom_gist" ON "storm_contours" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "storms_geom_075_gist" ON "storms" USING gist ("geom_075");--> statement-breakpoint
CREATE INDEX "storms_convective_day_idx" ON "storms" USING btree ("convective_day");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_campaigns_platform_external_uniq" ON "ad_campaigns" USING btree ("platform","external_campaign_id") WHERE "ad_campaigns"."external_campaign_id" is not null;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_storm_ad_budget_cents_check" CHECK ("company_settings"."storm_ad_budget_cents" between 0 and 1000000);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_storm_ad_days_check" CHECK ("company_settings"."storm_ad_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_storm_ad_google_share_pct_check" CHECK ("company_settings"."storm_ad_google_share_pct" between 0 and 100);--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sms_consent_source_check" CHECK ("customers"."sms_consent_source" in ('import', 'web_form', 'call', 'text', 'manual', 'door'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_email_to_email_check" CHECK ("messages"."channel" <> 'email' OR "messages"."to_email" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_kind_check" CHECK ("stored_files"."kind" in ('signed_proposal_pdf', 'storm_photo', 'ad_image'));