-- The run fence, "run again" bookkeeping and the scheduler's grants (Task 14). The schema changes
-- are generated (`drizzle-kit generate --name run_seq_rerun`), so 0006_snapshot.json stays accurate;
-- the grant is hand-written.
--
-- 1. agent_task_steps.run_seq: every claim takes the next number, and a run saves its outcome only
--    while the step is `running` at its own number. A person's retry puts `attempts` back to 0 but
--    never touches run_seq, so a run that outlived its lease cannot be mistaken for a newer one.
ALTER TABLE "agent_task_steps" ADD COLUMN "run_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- 2. agent_tasks.rerun_of_task_id: the expired plan a draft was made from by "run again". The
--    partial unique index makes that at most one copy per plan, even if two reruns race past the
--    service's own check. app_tenant's table-level grants on agent_tasks cover the new column.
ALTER TABLE "agent_tasks" ADD COLUMN "rerun_of_task_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_company_rerun_of_uniq" ON "agent_tasks" USING btree ("company_id","rerun_of_task_id") WHERE "agent_tasks"."rerun_of_task_id" is not null;
--> statement-breakpoint

-- 3. The sweeper's fan-out (app_system) finds the companies with a dead run from the lease. It only
--    lists ids: putting the steps back is done per company as app_tenant, under RLS, so app_system
--    gets no UPDATE on agent_task_steps. Still never content (no payload, preview or result).
--    pg-boss also connects as app_system, but it runs with `createSchema: false` in the pgboss schema
--    0002 made, so app_system needs (and has) no CREATE on the database.
GRANT SELECT (lease_expires_at, run_seq) ON agent_task_steps TO app_system;
