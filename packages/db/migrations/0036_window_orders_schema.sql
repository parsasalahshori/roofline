CREATE TABLE "window_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"window_measurement_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"po_number" text DEFAULT '' NOT NULL,
	"ready_at" timestamp with time zone,
	"ready_by_user_id" uuid,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "window_orders_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "window_orders_company_measurement_uniq" UNIQUE("company_id","window_measurement_id"),
	CONSTRAINT "window_orders_status_check" CHECK ("window_orders"."status" in ('draft', 'ready', 'sent'))
);
--> statement-breakpoint
ALTER TABLE "company_settings" ADD COLUMN "window_order_settings" jsonb;--> statement-breakpoint
ALTER TABLE "window_orders" ADD CONSTRAINT "window_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_orders" ADD CONSTRAINT "window_orders_ready_by_user_id_users_id_fk" FOREIGN KEY ("ready_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_orders" ADD CONSTRAINT "window_orders_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_orders" ADD CONSTRAINT "window_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_orders" ADD CONSTRAINT "window_orders_company_measurement_fk" FOREIGN KEY ("company_id","window_measurement_id") REFERENCES "public"."window_measurements"("company_id","id") ON DELETE no action ON UPDATE no action;