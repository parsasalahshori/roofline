CREATE TABLE "agent_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by" uuid,
	"last_run_now_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_settings_company_agent_uniq" UNIQUE("company_id","agent"),
	CONSTRAINT "agent_settings_agent_check" CHECK ("agent_settings"."agent" in ('storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up', 'system'))
);
--> statement-breakpoint
CREATE TABLE "agent_task_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"step_id" uuid,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_task_events_kind_check" CHECK ("agent_task_events"."kind" in ('created', 'approved', 'partly_approved', 'declined', 'step_done', 'step_failed', 'step_attention', 'finished', 'expired')),
	CONSTRAINT "agent_task_events_actor_type_check" CHECK ("agent_task_events"."actor_type" in ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "time_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"minutes_per_unit" numeric(6, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "time_baselines_company_key_uniq" UNIQUE("company_id","key")
);
--> statement-breakpoint
CREATE TABLE "time_recounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"by_user_id" uuid NOT NULL,
	"from" timestamp with time zone NOT NULL,
	"to" timestamp with time zone NOT NULL,
	"before_minutes" numeric(12, 2) NOT NULL,
	"after_minutes" numeric(12, 2) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD COLUMN "baseline_key" text;--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD COLUMN "units" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD COLUMN "minutes_per_unit" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD COLUMN "minutes_saved" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_paused_by_users_id_fk" FOREIGN KEY ("paused_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_events" ADD CONSTRAINT "agent_task_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_events" ADD CONSTRAINT "agent_task_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_events" ADD CONSTRAINT "agent_task_events_company_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."agent_tasks"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_task_events" ADD CONSTRAINT "agent_task_events_company_step_fk" FOREIGN KEY ("company_id","step_id") REFERENCES "public"."agent_task_steps"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_baselines" ADD CONSTRAINT "time_baselines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_recounts" ADD CONSTRAINT "time_recounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_recounts" ADD CONSTRAINT "time_recounts_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_task_events_company_at_idx" ON "agent_task_events" USING btree ("company_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_task_events_task_idx" ON "agent_task_events" USING btree ("company_id","task_id","at");--> statement-breakpoint
CREATE INDEX "time_recounts_company_at_idx" ON "time_recounts" USING btree ("company_id","at");