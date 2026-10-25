CREATE TABLE "window_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"homeowner_request_id" uuid NOT NULL,
	"scan_id" text NOT NULL,
	"window_id" text NOT NULL,
	"app" text,
	"device" text,
	"wall" jsonb,
	"frames" jsonb NOT NULL,
	"marks" jsonb NOT NULL,
	"marks_original" jsonb NOT NULL,
	"phone_result" jsonb,
	"server_result" jsonb NOT NULL,
	"status" text NOT NULL,
	"expedite" boolean DEFAULT false NOT NULL,
	"sla_due_at" timestamp with time zone NOT NULL,
	"junior_user_id" uuid,
	"junior_at" timestamp with time zone,
	"senior_user_id" uuid,
	"senior_at" timestamp with time zone,
	"outcome" text,
	"outcome_reason" text,
	"overrode" boolean DEFAULT false NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "window_scans_company_id_id_uniq" UNIQUE("company_id","id"),
	CONSTRAINT "window_scans_request_scan_uniq" UNIQUE("company_id","homeowner_request_id","scan_id"),
	CONSTRAINT "window_scans_status_check" CHECK ("window_scans"."status" in ('processing', 'measured', 'needs_review', 'in_review', 'junior_done', 'visit_required')),
	CONSTRAINT "window_scans_outcome_check" CHECK ("window_scans"."outcome" in ('measured', 'visit_required')),
	CONSTRAINT "window_scans_visit_reason_check" CHECK ("window_scans"."status" <> 'visit_required' or ("window_scans"."outcome_reason" is not null and length(btrim("window_scans"."outcome_reason")) > 0))
);
--> statement-breakpoint
ALTER TABLE "window_scans" ADD CONSTRAINT "window_scans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_scans" ADD CONSTRAINT "window_scans_junior_user_id_users_id_fk" FOREIGN KEY ("junior_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_scans" ADD CONSTRAINT "window_scans_senior_user_id_users_id_fk" FOREIGN KEY ("senior_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "window_scans" ADD CONSTRAINT "window_scans_company_request_fk" FOREIGN KEY ("company_id","homeowner_request_id") REFERENCES "public"."homeowner_requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "window_scans_company_status_idx" ON "window_scans" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "window_scans_window_idx" ON "window_scans" USING btree ("company_id","homeowner_request_id","window_id");--> statement-breakpoint
-- Grants and row-level security (the pattern of 0043): a table a later migration adds gets no grants by default (see
-- 0002), so each one below is deliberate and test/rls.test.ts lists them. app_tenant reads, writes and changes the
-- company's scans (the signed-out homeowner routes and the staff review routes both run on the tenant pool inside
-- withTenant); no DELETE, a scan is the record of what was measured and who checked it; app_system gets nothing.
GRANT SELECT, INSERT, UPDATE ON window_scans TO app_tenant;
--> statement-breakpoint
ALTER TABLE window_scans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE window_scans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON window_scans
  USING (company_id = nullif(current_setting('app.company_id', true), '')::uuid)
  WITH CHECK (company_id = nullif(current_setting('app.company_id', true), '')::uuid);
