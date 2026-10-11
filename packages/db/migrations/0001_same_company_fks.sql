-- NOTE: statements reordered by hand. drizzle-kit emits the composite foreign keys before the
-- unique constraints they reference, which Postgres rejects. Uniques first, then the foreign keys.
ALTER TABLE "agent_task_steps" DROP CONSTRAINT "agent_task_steps_task_id_agent_tasks_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT "jobs_property_id_properties_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_step_id_agent_task_steps_id_fk";
--> statement-breakpoint
ALTER TABLE "properties" DROP CONSTRAINT "properties_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_company_id_id_uniq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_company_id_id_uniq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_id_uniq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_company_id_id_uniq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "agent_task_steps" ADD CONSTRAINT "agent_task_steps_company_task_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."agent_tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_property_fk" FOREIGN KEY ("company_id","property_id") REFERENCES "public"."properties"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_step_fk" FOREIGN KEY ("company_id","step_id") REFERENCES "public"."agent_task_steps"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_company_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."customers"("company_id","id") ON DELETE no action ON UPDATE no action;
