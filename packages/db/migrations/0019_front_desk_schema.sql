CREATE TABLE "line_lookups" (
	"e164" text PRIMARY KEY NOT NULL,
	"line_type" text NOT NULL,
	"looked_up_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blocked_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"e164" text NOT NULL,
	"reason" text,
	"blocked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid,
	"call_sid" text NOT NULL,
	"from_e164" text NOT NULL,
	"to_e164" text NOT NULL,
	"forwarded_from" text,
	"stir_verstat" text,
	"status" text DEFAULT 'ringing' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"ai_seconds" integer DEFAULT 0 NOT NULL,
	"billed_minutes" integer DEFAULT 0 NOT NULL,
	"recording_key" text,
	"recording_status" text DEFAULT 'none' NOT NULL,
	"recording_seconds" integer,
	"consent_regime" text,
	"transcript_stored" boolean DEFAULT false NOT NULL,
	"transfer_user_id" uuid,
	"transfer_result" text,
	"spam_reason" text,
	"text_back_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_call_sid_unique" UNIQUE("call_sid"),
	CONSTRAINT "calls_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "calls_status_check" CHECK ("calls"."status" in ('ringing', 'ai', 'ringing_team', 'transferred', 'ended', 'rejected', 'failed')),
	CONSTRAINT "calls_recording_status_check" CHECK ("calls"."recording_status" in ('none', 'recording', 'stopped_by_caller', 'stored', 'deleted')),
	CONSTRAINT "calls_consent_regime_check" CHECK ("calls"."consent_regime" in ('all_party', 'one_party')),
	CONSTRAINT "calls_transfer_result_check" CHECK ("calls"."transfer_result" in ('answered', 'no_answer', 'none'))
);
--> statement-breakpoint
CREATE TABLE "claim_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid,
	"conversation_id" uuid,
	"insurer" text NOT NULL,
	"claim_number" text,
	"date_of_loss" date,
	"description" text NOT NULL,
	"adjuster_visit_at" timestamp with time zone,
	"taken_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claim_intakes_taken_by_check" CHECK ("claim_intakes"."taken_by" in ('front_desk', 'user'))
);
--> statement-breakpoint
CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"call_id" uuid,
	"position" integer NOT NULL,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text,
	"route" text,
	"router_ms" integer,
	"first_token_ms" integer,
	"total_ms" integer,
	"input_tokens" integer,
	"cached_tokens" integer,
	"output_tokens" integer,
	"tool_calls" jsonb,
	"guard_hits" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "conversation_turns_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "conversation_turns_speaker_check" CHECK ("conversation_turns"."speaker" in ('caller', 'assistant', 'team', 'system')),
	CONSTRAINT "conversation_turns_route_check" CHECK ("conversation_turns"."route" in ('fast', 'opus', 'transfer', 'end'))
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"customer_id" uuid,
	"phone_e164" text NOT NULL,
	"company_number_e164" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"handled_by" text DEFAULT 'assistant' NOT NULL,
	"team_until" timestamp with time zone,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"outcome" text,
	"identity" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "conversations_channel_check" CHECK ("conversations"."channel" in ('voice', 'sms')),
	CONSTRAINT "conversations_status_check" CHECK ("conversations"."status" in ('active', 'ended')),
	CONSTRAINT "conversations_handled_by_check" CHECK ("conversations"."handled_by" in ('assistant', 'team')),
	CONSTRAINT "conversations_outcome_check" CHECK ("conversations"."outcome" in ('booked', 'confirmed', 'moved', 'canceled', 'job_question', 'claim', 'message', 'transferred', 'spam', 'abandoned', 'other')),
	CONSTRAINT "conversations_identity_check" CHECK ("conversations"."identity" in ('unknown', 'matched', 'verified'))
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_source_check";--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "transfer_phone_e164" text;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "on_call_order" integer;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "recording_ack_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "confirmed_via" text;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_texts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "ring_team_first_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_voice" text DEFAULT 'maya' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_facts" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_can_move" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "front_desk_can_cancel" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "missed_call_text_back" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "recording_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "transcript_retention_days" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "max_concurrent_ai_calls" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "forwarding_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_id_uniq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "blocked_numbers" ADD CONSTRAINT "blocked_numbers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_numbers" ADD CONSTRAINT "blocked_numbers_blocked_by_users_id_fk" FOREIGN KEY ("blocked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_transfer_user_id_users_id_fk" FOREIGN KEY ("transfer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_company_text_back_message_fk" FOREIGN KEY ("company_id","text_back_message_id") REFERENCES "public"."messages"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_intakes" ADD CONSTRAINT "claim_intakes_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_turns" ADD CONSTRAINT "conversation_turns_company_call_fk" FOREIGN KEY ("company_id","call_id") REFERENCES "public"."calls"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blocked_numbers_company_e164_uniq" ON "blocked_numbers" USING btree ("company_id","e164");--> statement-breakpoint
CREATE INDEX "calls_company_started_idx" ON "calls" USING btree ("company_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_turns_conversation_position_uniq" ON "conversation_turns" USING btree ("conversation_id","position");--> statement-breakpoint
CREATE INDEX "conversations_company_last_message_idx" ON "conversations" USING btree ("company_id","last_message_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_active_sms_uniq" ON "conversations" USING btree ("company_id","phone_e164") WHERE "conversations"."channel" = 'sms' and "conversations"."status" = 'active';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_conversation_fk" FOREIGN KEY ("company_id","conversation_id") REFERENCES "public"."conversations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_confirmed_via_check" CHECK ("appointments"."confirmed_via" in ('call', 'text', 'manual'));--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_ring_team_first_seconds_check" CHECK ("company_settings"."ring_team_first_seconds" between 0 and 30);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_front_desk_voice_check" CHECK ("company_settings"."front_desk_voice" in ('maya', 'claire', 'daniel', 'marcus'));--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_front_desk_facts_check" CHECK (char_length("company_settings"."front_desk_facts") <= 2000);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_recording_retention_days_check" CHECK ("company_settings"."recording_retention_days" between 0 and 365);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_transcript_retention_days_check" CHECK ("company_settings"."transcript_retention_days" between 30 and 730);--> statement-breakpoint
ALTER TABLE "company_settings" ADD CONSTRAINT "company_settings_max_concurrent_ai_calls_check" CHECK ("company_settings"."max_concurrent_ai_calls" between 1 and 10);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_check" CHECK ("jobs"."source" in ('storm', 'call', 'text', 'web', 'referral', 'import', 'manual', 'front_desk'));