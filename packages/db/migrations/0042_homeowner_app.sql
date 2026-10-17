CREATE TABLE "homeowner_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"services" text[] NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"callback_reason" text,
	"quote_estimate_id" uuid,
	"property_id" uuid,
	"window_measurement_id" uuid,
	"window_count_override" integer,
	"quote_request_id" uuid,
	"call_me" boolean DEFAULT false NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "homeowner_requests_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "homeowner_requests_token_hash_uniq" UNIQUE("token_hash"),
	CONSTRAINT "homeowner_requests_status_check" CHECK ("homeowner_requests"."status" in ('ready', 'callback')),
	CONSTRAINT "homeowner_requests_callback_reason_check" CHECK ("homeowner_requests"."callback_reason" in ('unit', 'address', 'home', 'busy')),
	CONSTRAINT "homeowner_requests_callback_pair_check" CHECK (("homeowner_requests"."status" = 'callback') = ("homeowner_requests"."callback_reason" is not null)),
	CONSTRAINT "homeowner_requests_services_check" CHECK (cardinality("homeowner_requests"."services") between 1 and 3 and "homeowner_requests"."services" <@ array['windows','roof','gutters']::text[]),
	CONSTRAINT "homeowner_requests_window_count_check" CHECK ("homeowner_requests"."window_count_override" is null or "homeowner_requests"."window_count_override" between 1 and 80)
);
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_source_check";--> statement-breakpoint
ALTER TABLE "homeowner_requests" ADD CONSTRAINT "homeowner_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeowner_requests" ADD CONSTRAINT "homeowner_requests_company_estimate_fk" FOREIGN KEY ("company_id","quote_estimate_id") REFERENCES "public"."quote_estimates"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeowner_requests" ADD CONSTRAINT "homeowner_requests_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeowner_requests" ADD CONSTRAINT "homeowner_requests_company_measurement_fk" FOREIGN KEY ("company_id","window_measurement_id") REFERENCES "public"."window_measurements"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homeowner_requests" ADD CONSTRAINT "homeowner_requests_company_quote_request_fk" FOREIGN KEY ("company_id","quote_request_id") REFERENCES "public"."quote_requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "homeowner_requests_company_created_idx" ON "homeowner_requests" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "homeowner_requests_property_idx" ON "homeowner_requests" USING btree ("company_id","property_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_check" CHECK ("jobs"."source" in ('storm', 'call', 'text', 'web', 'referral', 'import', 'manual', 'front_desk', 'app'));