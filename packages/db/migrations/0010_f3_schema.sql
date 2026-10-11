CREATE TABLE "early_delivery_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider_message_sid" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "early_delivery_reports_company_sid_status_uniq" UNIQUE("company_id","provider_message_sid","status"),
	CONSTRAINT "early_delivery_reports_status_check" CHECK ("early_delivery_reports"."status" in ('delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"cells" jsonb NOT NULL,
	"outcome" text,
	"reason" text,
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_import_row_uniq" UNIQUE("import_id","row_number"),
	CONSTRAINT "import_rows_outcome_check" CHECK ("import_rows"."outcome" in ('created', 'updated', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"consent_attested" boolean DEFAULT false NOT NULL,
	"consent_text" text,
	"attested_by_user_id" uuid,
	"attested_at" timestamp with time zone,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error_file_url" text,
	"error_plain" text,
	"created_by_user_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "imports_status_check" CHECK ("imports"."status" in ('uploaded', 'queued', 'processing', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "setup_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_items_company_key_uniq" UNIQUE("company_id","key"),
	CONSTRAINT "setup_items_key_check" CHECK ("setup_items"."key" in ('company_basics', 'import_customers', 'texting_registration', 'invite_team', 'payment_method', 'prices_and_tiers', 'connect_calendar', 'phone_number', 'connect_ads')),
	CONSTRAINT "setup_items_status_check" CHECK ("setup_items"."status" in ('todo', 'in_progress', 'waiting', 'done', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "location" geometry(Point,4326);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "service_area_miles" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "billing_period_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "past_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD COLUMN "customer_profile_sid" text;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD COLUMN "trust_product_sid" text;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD COLUMN "brand_info" jsonb;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD COLUMN "rejected_fields" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "texting_registrations" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "meter_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_events" ADD COLUMN "stripe_invoice_item_id" text;--> statement-breakpoint
ALTER TABLE "early_delivery_reports" ADD CONSTRAINT "early_delivery_reports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_company_import_fk" FOREIGN KEY ("company_id","import_id") REFERENCES "public"."imports"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_attested_by_user_id_users_id_fk" FOREIGN KEY ("attested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_items" ADD CONSTRAINT "setup_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_rows_import_outcome_idx" ON "import_rows" USING btree ("import_id","outcome");--> statement-breakpoint
CREATE INDEX "imports_company_created_idx" ON "imports" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "customers_phones_gin" ON "customers" USING gin ("phones" jsonb_path_ops);--> statement-breakpoint
CREATE INDEX "customers_emails_gin" ON "customers" USING gin ("emails");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_inbound_sid_uniq" ON "messages" USING btree ("company_id","provider_message_sid") WHERE "messages"."direction" = 'in';--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_ref_uniq" ON "usage_events" USING btree ("company_id","kind","ref_type","ref_id") WHERE "usage_events"."ref_id" is not null;--> statement-breakpoint
CREATE INDEX "usage_events_unreported_idx" ON "usage_events" USING btree ("company_id") WHERE "usage_events"."reported_to_stripe_at" is null;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_service_area_miles_check" CHECK ("companies"."service_area_miles" in (10, 20, 40, 60));