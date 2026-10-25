CREATE TABLE "backoffice_order_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "backoffice_order_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"by_user_id" uuid,
	"note" text DEFAULT '' NOT NULL,
	"planned_for" date,
	"notified" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backoffice_order_events_stage_check" CHECK ("backoffice_order_events"."stage" in ('sold', 'measure-booked', 'measured', 'ordered', 'in-production', 'built', 'shipped', 'install-scheduled', 'installed', 'complete'))
);
--> statement-breakpoint
CREATE TABLE "backoffice_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"stage" text DEFAULT 'sold' NOT NULL,
	"stage_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"units" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"window_order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backoffice_orders_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "backoffice_orders_company_quote_uniq" UNIQUE("company_id","quote_id"),
	CONSTRAINT "backoffice_orders_stage_check" CHECK ("backoffice_orders"."stage" in ('sold', 'measure-booked', 'measured', 'ordered', 'in-production', 'built', 'shipped', 'install-scheduled', 'installed', 'complete')),
	CONSTRAINT "backoffice_orders_amounts_check" CHECK ("backoffice_orders"."units" >= 0 and "backoffice_orders"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "backoffice_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"tier" text DEFAULT 'better' NOT NULL,
	"catalog_version" integer DEFAULT 0 NOT NULL,
	"designs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"accessories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"discount_percent" numeric(5, 2) DEFAULT 0 NOT NULL,
	"house_visual" jsonb,
	"catalog_snapshot" jsonb,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backoffice_quotes_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "backoffice_quotes_status_check" CHECK ("backoffice_quotes"."status" in ('draft', 'presented', 'accepted', 'declined')),
	CONSTRAINT "backoffice_quotes_tier_check" CHECK ("backoffice_quotes"."tier" in ('good', 'better', 'best')),
	CONSTRAINT "backoffice_quotes_discount_check" CHECK ("backoffice_quotes"."discount_percent" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "backoffice_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "product_catalog" jsonb;--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "backoffice" jsonb;--> statement-breakpoint
ALTER TABLE "backoffice_order_events" ADD CONSTRAINT "backoffice_order_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_order_events" ADD CONSTRAINT "backoffice_order_events_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_order_events" ADD CONSTRAINT "backoffice_order_events_company_order_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."backoffice_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_orders" ADD CONSTRAINT "backoffice_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_orders" ADD CONSTRAINT "backoffice_orders_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_orders" ADD CONSTRAINT "backoffice_orders_company_quote_fk" FOREIGN KEY ("company_id","quote_id") REFERENCES "public"."backoffice_quotes"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_orders" ADD CONSTRAINT "backoffice_orders_company_window_order_fk" FOREIGN KEY ("company_id","window_order_id") REFERENCES "public"."window_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_quotes" ADD CONSTRAINT "backoffice_quotes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_quotes" ADD CONSTRAINT "backoffice_quotes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backoffice_quotes" ADD CONSTRAINT "backoffice_quotes_company_job_fk" FOREIGN KEY ("company_id","job_id") REFERENCES "public"."jobs"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backoffice_order_events_order_idx" ON "backoffice_order_events" USING btree ("company_id","order_id","seq");--> statement-breakpoint
CREATE INDEX "backoffice_orders_company_stage_idx" ON "backoffice_orders" USING btree ("company_id","stage");--> statement-breakpoint
CREATE INDEX "backoffice_orders_job_idx" ON "backoffice_orders" USING btree ("company_id","job_id");--> statement-breakpoint
CREATE INDEX "backoffice_quotes_company_job_idx" ON "backoffice_quotes" USING btree ("company_id","job_id");--> statement-breakpoint
CREATE INDEX "backoffice_quotes_company_updated_idx" ON "backoffice_quotes" USING btree ("company_id","updated_at");