CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"by_actor" text NOT NULL,
	"by_user_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_events_from_status_check" CHECK ("claim_events"."from_status" in ('not_filed', 'filed', 'adjuster_scheduled', 'inspected', 'approved', 'partly_approved', 'denied', 'supplement_requested', 'closed')),
	CONSTRAINT "claim_events_to_status_check" CHECK ("claim_events"."to_status" in ('not_filed', 'filed', 'adjuster_scheduled', 'inspected', 'approved', 'partly_approved', 'denied', 'supplement_requested', 'closed')),
	CONSTRAINT "claim_events_by_actor_check" CHECK ("claim_events"."by_actor" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"insurer" text,
	"claim_number" text,
	"date_of_loss" date,
	"status" text DEFAULT 'not_filed' NOT NULL,
	"adjuster_name" text,
	"adjuster_phone" text,
	"adjuster_email" text,
	"adjuster_appointment_id" uuid,
	"deductible_cents" integer,
	"notes" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "claims_company_job_uniq" UNIQUE("company_id","job_id"),
	CONSTRAINT "claims_deductible_cents_check" CHECK ("claims"."deductible_cents" >= 0),
	CONSTRAINT "claims_status_check" CHECK ("claims"."status" in ('not_filed', 'filed', 'adjuster_scheduled', 'inspected', 'approved', 'partly_approved', 'denied', 'supplement_requested', 'closed'))
);
--> statement-breakpoint
CREATE TABLE "follow_up_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"job_id" uuid,
	"kind" text NOT NULL,
	"n" integer DEFAULT 1 NOT NULL,
	"message_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_up_log_n_check" CHECK ("follow_up_log"."n" >= 1),
	CONSTRAINT "follow_up_log_kind_check" CHECK ("follow_up_log"."kind" in ('proposal', 'lead', 'review', 'claims', 'reminder', 'no_show'))
);
--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "moved_by_task_id" uuid;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "claims_nudge_days" integer[] DEFAULT '{3,5,7}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "weather_rain_pct" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "weather_gust_mph" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "reminder_hour" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "followup_days" integer[] DEFAULT '{3,4}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "lead_followup_days" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "review_link" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "review_delay_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "followup_reviews" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "followup_leads" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "followup_proposals" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_company_claim_fk" FOREIGN KEY ("company_id","claim_id") REFERENCES "public"."claims"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_company_adjuster_appointment_fk" FOREIGN KEY ("company_id","adjuster_appointment_id") REFERENCES "public"."appointments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_log" ADD CONSTRAINT "follow_up_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_log" ADD CONSTRAINT "follow_up_log_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_log" ADD CONSTRAINT "follow_up_log_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_up_log" ADD CONSTRAINT "follow_up_log_company_message_fk" FOREIGN KEY ("company_id","message_id") REFERENCES "public"."messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "claim_events_claim_at_idx" ON "claim_events" USING btree ("company_id","claim_id","at");--> statement-breakpoint
CREATE INDEX "claims_company_status_idx" ON "claims" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "follow_up_log_customer_at_idx" ON "follow_up_log" USING btree ("company_id","customer_id","at");--> statement-breakpoint
CREATE INDEX "follow_up_log_job_kind_idx" ON "follow_up_log" USING btree ("company_id","job_id","kind");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_company_moved_by_task_fk" FOREIGN KEY ("company_id","moved_by_task_id") REFERENCES "public"."agent_tasks"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_weather_rain_pct_check" CHECK ("company_settings"."weather_rain_pct" between 0 and 100);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_weather_gust_mph_check" CHECK ("company_settings"."weather_gust_mph" between 1 and 100);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_reminder_hour_check" CHECK ("company_settings"."reminder_hour" between 0 and 23);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_lead_followup_days_check" CHECK ("company_settings"."lead_followup_days" between 1 and 30);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_review_delay_days_check" CHECK ("company_settings"."review_delay_days" between 0 and 30);