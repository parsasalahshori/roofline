-- NOTE: CREATE EXTENSION lines below were hand-prepended; do not regenerate this file.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text,
	"phone_e164" text,
	"email" text,
	"website" text,
	"address_street" text,
	"address_city" text,
	"address_state" text,
	"address_zip" text,
	"timezone" text DEFAULT 'America/Chicago' NOT NULL,
	"service_area" geometry(MultiPolygon,4326),
	"logo_url" text,
	"status" text DEFAULT 'trial' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"stripe_customer_id" text,
	"plan_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_slug_unique" UNIQUE("slug"),
	CONSTRAINT "companies_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "companies_status_check" CHECK ("companies"."status" in ('trial', 'trial_ended', 'active', 'past_due', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "company_phone_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"capabilities" text[] DEFAULT '{}' NOT NULL,
	"provider_sid" text,
	"purpose" text DEFAULT 'main' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_phone_numbers_e164_unique" UNIQUE("e164"),
	CONSTRAINT "company_phone_numbers_purpose_check" CHECK ("company_phone_numbers"."purpose" in ('main'))
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_role_check" CHECK ("invites"."role" in ('owner', 'office', 'rep'))
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"can_approve_spend" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_today_shown_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_check" CHECK ("memberships"."role" in ('owner', 'office', 'rep')),
	CONSTRAINT "memberships_status_check" CHECK ("memberships"."status" in ('invited', 'active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"active_company_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "texting_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subaccount_sid" text,
	"subaccount_auth_token_encrypted" "bytea",
	"brand_sid" text,
	"brand_status" text,
	"campaign_sid" text,
	"campaign_status" text DEFAULT 'none' NOT NULL,
	"messaging_service_sid" text,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"rejection_reason_plain" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "texting_registrations_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "texting_registrations_campaign_status_check" CHECK ("texting_registrations"."campaign_status" in ('none', 'pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "user_tokens_kind_check" CHECK ("user_tokens"."kind" in ('verify_email', 'reset_password'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"phone_e164" text,
	"password_hash" text,
	"google_sub" text,
	"email_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"actor_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_subject_type_check" CHECK ("activities"."subject_type" in ('customer', 'property', 'job')),
	CONSTRAINT "activities_actor_type_check" CHECK ("activities"."actor_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "agent_task_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"approval_class" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"edited_by_user_id" uuid,
	"edited_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"idempotency_key" text NOT NULL,
	"error_plain" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_steps_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "agent_task_steps_task_position_uniq" UNIQUE("task_id","position"),
	CONSTRAINT "agent_task_steps_approval_class_check" CHECK ("agent_task_steps"."approval_class" in ('message', 'spend', 'internal')),
	CONSTRAINT "agent_task_steps_status_check" CHECK ("agent_task_steps"."status" in ('pending', 'awaiting_owner', 'skipped', 'queued', 'running', 'done', 'failed', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"subject_type" text,
	"subject_id" uuid,
	"mode" text DEFAULT 'needs_approval' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"declined_by_user_id" uuid,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"minutes_saved" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tasks_agent_check" CHECK ("agent_tasks"."agent" in ('storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up', 'system')),
	CONSTRAINT "agent_tasks_mode_check" CHECK ("agent_tasks"."mode" in ('needs_approval', 'live')),
	CONSTRAINT "agent_tasks_status_check" CHECK ("agent_tasks"."status" in ('draft', 'awaiting_owner', 'approved', 'declined', 'expired', 'running', 'done', 'partly_done', 'needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"hourly_rate_cents" integer DEFAULT 2800 NOT NULL,
	"hail_threshold_in" numeric(4, 2) DEFAULT 1 NOT NULL,
	"marketing_cap_per_7d" integer DEFAULT 2 NOT NULL,
	"financing_apr_bps" integer,
	"financing_term_months" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_settings_company_id_unique" UNIQUE("company_id"),
	CONSTRAINT "company_settings_marketing_cap_per_7d_check" CHECK ("company_settings"."marketing_cap_per_7d" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sms_consent_status" text DEFAULT 'none' NOT NULL,
	"sms_consent_source" text,
	"sms_consent_at" timestamp with time zone,
	"sms_consent_by_user_id" uuid,
	"sms_consent_evidence" jsonb,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"external_ref" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_sms_consent_status_check" CHECK ("customers"."sms_consent_status" in ('none', 'express', 'attested', 'written', 'revoked')),
	CONSTRAINT "customers_sms_consent_source_check" CHECK ("customers"."sms_consent_source" in ('import', 'web_form', 'call', 'text', 'manual')),
	CONSTRAINT "customers_source_check" CHECK ("customers"."source" in ('import', 'manual', 'call', 'text', 'web', 'storm'))
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"encrypted_credentials" "bytea",
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"connected_by_user_id" uuid,
	"connected_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrations_company_provider_uniq" UNIQUE("company_id","provider"),
	CONSTRAINT "integrations_status_check" CHECK ("integrations"."status" in ('connected', 'error', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"stage" text DEFAULT 'lead' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"value_cents" integer,
	"assigned_user_id" uuid,
	"created_by_user_id" uuid,
	"storm_id" uuid,
	"lost_reason" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_stage_check" CHECK ("jobs"."stage" in ('lead', 'inspection', 'proposal', 'won', 'installed', 'lost')),
	CONSTRAINT "jobs_source_check" CHECK ("jobs"."source" in ('storm', 'call', 'text', 'web', 'referral', 'import', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"purpose" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"block_rule" text,
	"block_reason" text,
	"scheduled_for" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"provider_message_sid" text,
	"step_id" uuid,
	"dedupe_key" text,
	"segments" integer DEFAULT 1 NOT NULL,
	"to_e164" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_channel_check" CHECK ("messages"."channel" in ('sms', 'mms', 'email')),
	CONSTRAINT "messages_direction_check" CHECK ("messages"."direction" in ('out', 'in')),
	CONSTRAINT "messages_purpose_check" CHECK ("messages"."purpose" in ('marketing', 'informational')),
	CONSTRAINT "messages_status_check" CHECK ("messages"."status" in ('scheduled', 'queued', 'sent', 'delivered', 'failed', 'blocked', 'received')),
	CONSTRAINT "messages_block_rule_check" CHECK ("messages"."block_rule" in ('billing', 'registration', 'contact', 'consent', 'content', 'dedupe', 'frequency', 'quiet_hours'))
);
--> statement-breakpoint
CREATE TABLE "opt_outs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"keyword" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opt_outs_company_phone_uniq" UNIQUE("company_id","phone_e164")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid,
	"address_line" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"zip" text NOT NULL,
	"address_key" text NOT NULL,
	"geom" geometry(Point,4326),
	"timezone" text,
	"geocode_source" text,
	"geocode_accuracy" text,
	"footprint_id" text,
	"year_built" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "properties_company_address_key_uniq" UNIQUE("company_id","address_key")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" numeric(14, 4) NOT NULL,
	"unit_cost_cents" numeric(14, 4),
	"ref_type" text,
	"ref_id" text,
	"reported_to_stripe_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_kind_check" CHECK ("usage_events"."kind" in ('ai_call_minute', 'sms_segment', 'mms', 'exact_report', 'texting_registration_fee', 'phone_number_month'))
);
--> statement-breakpoint
ALTER TABLE "company_phone_numbers" ADD CONSTRAINT "company_phone_numbers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_company_id_companies_id_fk" FOREIGN KEY ("active_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD CONSTRAINT "texting_registrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_edited_by_user_id_users_id_fk" FOREIGN KEY ("edited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_declined_by_user_id_users_id_fk" FOREIGN KEY ("declined_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sms_consent_by_user_id_users_id_fk" FOREIGN KEY ("sms_consent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_step_id_agent_task_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."agent_task_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opt_outs" ADD CONSTRAINT "opt_outs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_phone_numbers_company_idx" ON "company_phone_numbers" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "invites_company_idx" ON "invites" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_company_user_uniq" ON "memberships" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_tokens_user_idx" ON "user_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_uniq" ON "webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "activities_subject_idx" ON "activities" USING btree ("company_id","subject_type","subject_id","at");--> statement-breakpoint
CREATE INDEX "agent_task_steps_status_idx" ON "agent_task_steps" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_company_status_idx" ON "agent_tasks" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_expires_idx" ON "agent_tasks" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "audit_log_company_at_idx" ON "audit_log" USING btree ("company_id","at");--> statement-breakpoint
CREATE INDEX "customers_company_idx" ON "customers" USING btree ("company_id","archived_at");--> statement-breakpoint
CREATE INDEX "jobs_company_stage_idx" ON "jobs" USING btree ("company_id","stage");--> statement-breakpoint
CREATE INDEX "jobs_customer_idx" ON "jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "jobs_property_idx" ON "jobs" USING btree ("property_id");--> statement-breakpoint
CREATE INDEX "jobs_assigned_idx" ON "jobs" USING btree ("assigned_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_step_customer_uniq" ON "messages" USING btree ("step_id","customer_id") WHERE "messages"."step_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_customer_idx" ON "messages" USING btree ("company_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_dedupe_idx" ON "messages" USING btree ("company_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "messages_status_scheduled_idx" ON "messages" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE INDEX "messages_provider_sid_idx" ON "messages" USING btree ("provider_message_sid");--> statement-breakpoint
CREATE INDEX "properties_geom_gist" ON "properties" USING gist ("geom");--> statement-breakpoint
CREATE INDEX "properties_customer_idx" ON "properties" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "usage_events_company_at_idx" ON "usage_events" USING btree ("company_id","at");