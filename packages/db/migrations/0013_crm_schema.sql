CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"job_id" uuid,
	"customer_id" uuid,
	"property_id" uuid,
	"assigned_user_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" uuid,
	"canceled_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "appointments_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "appointments_ends_after_starts_check" CHECK ("appointments"."ends_at" > "appointments"."starts_at"),
	CONSTRAINT "appointments_kind_check" CHECK ("appointments"."kind" in ('inspection', 'install', 'adjuster', 'other')),
	CONSTRAINT "appointments_status_check" CHECK ("appointments"."status" in ('scheduled', 'completed', 'canceled', 'no_show')),
	CONSTRAINT "appointments_source_check" CHECK ("appointments"."source" in ('manual', 'front_desk', 'scheduler', 'external'))
);
--> statement-breakpoint
CREATE TABLE "calendar_busy_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_busy_blocks_connection_event_uniq" UNIQUE("connection_id","provider_event_id"),
	CONSTRAINT "calendar_busy_blocks_ends_after_starts_check" CHECK ("calendar_busy_blocks"."ends_at" > "calendar_busy_blocks"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_email" text,
	"calendar_id" text,
	"calendar_name" text,
	"encrypted_credentials" "bytea" NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_error_plain" text,
	"sync_cursor" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_company_user_uniq" UNIQUE("company_id","user_id"),
	CONSTRAINT "calendar_connections_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "calendar_connections_provider_check" CHECK ("calendar_connections"."provider" in ('google', 'microsoft')),
	CONSTRAINT "calendar_connections_status_check" CHECK ("calendar_connections"."status" in ('connected', 'error', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "calendar_event_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"etag" text,
	"last_pushed_at" timestamp with time zone,
	"push_error_plain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_links_appointment_uniq" UNIQUE("appointment_id"),
	CONSTRAINT "calendar_event_links_connection_event_uniq" UNIQUE("connection_id","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "member_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"weekly_hours" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_schedules_company_user_uniq" UNIQUE("company_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pricebooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"prices" jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricebooks_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE "quote_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quote_counters_company_id_unique" UNIQUE("company_id")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"measurement" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"prices" jsonb NOT NULL,
	"calculation" jsonb NOT NULL,
	"notes" text,
	"valid_until" date NOT NULL,
	"created_by_user_id" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "quotes_company_number_uniq" UNIQUE("company_id","number"),
	CONSTRAINT "quotes_status_check" CHECK ("quotes"."status" in ('draft', 'final'))
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "work_hours" jsonb DEFAULT '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[["08:00","12:00"]],"sun":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "travel_buffer_minutes" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "min_notice_minutes" integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "stuck_after_days" integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "next_step_on" date;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_id_uniq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_busy_blocks" ADD CONSTRAINT "calendar_busy_blocks_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."calendar_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_company_appointment_fk" FOREIGN KEY ("company_id","appointment_id") REFERENCES "public"."appointments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_links" ADD CONSTRAINT "calendar_event_links_company_connection_fk" FOREIGN KEY ("company_id","connection_id") REFERENCES "public"."calendar_connections"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_schedules" ADD CONSTRAINT "member_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_schedules" ADD CONSTRAINT "member_schedules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebooks" ADD CONSTRAINT "pricebooks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebooks" ADD CONSTRAINT "pricebooks_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_counters" ADD CONSTRAINT "quote_counters_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_company_starts_idx" ON "appointments" USING btree ("company_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_company_assignee_starts_idx" ON "appointments" USING btree ("company_id","assigned_user_id","starts_at");--> statement-breakpoint
CREATE INDEX "appointments_job_idx" ON "appointments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "calendar_busy_blocks_company_user_starts_idx" ON "calendar_busy_blocks" USING btree ("company_id","user_id","starts_at");--> statement-breakpoint
CREATE INDEX "quotes_job_idx" ON "quotes" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "texting_registrations_messaging_service_sid_uniq" ON "texting_registrations" USING btree ("messaging_service_sid") WHERE "texting_registrations"."messaging_service_sid" is not null;--> statement-breakpoint
CREATE INDEX "jobs_company_stage_changed_idx" ON "jobs" USING btree ("company_id","stage","stage_changed_at");--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_travel_buffer_minutes_check" CHECK ("company_settings"."travel_buffer_minutes" between 0 and 120);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_min_notice_minutes_check" CHECK ("company_settings"."min_notice_minutes" between 0 and 4320);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_stuck_after_days_check" CHECK ("company_settings"."stuck_after_days" between 3 and 90);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_next_step_check" CHECK (char_length("jobs"."next_step") <= 120);