-- The run fence and the scheduler's grants (Task 14). Generated with `drizzle-kit generate --name
-- step_run_seq` for the column, so 0006_snapshot.json stays accurate; the grants are hand-written.
--
-- 1. agent_task_steps.run_seq: every claim takes the next number, and a run saves its outcome only
--    while the step is `running` at its own number. A person's retry puts `attempts` back to 0 but
--    never touches run_seq, so a run that outlived its lease cannot be mistaken for a newer one.
ALTER TABLE "agent_task_steps" ADD COLUMN "run_seq" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- 2. The sweeper's fan-out (app_system) finds the companies with a dead run from the lease. It only
--    lists ids: putting the steps back is done per company as app_tenant, under RLS, so app_system
--    gets no UPDATE on agent_task_steps. Still never content (no payload, preview or result).
GRANT SELECT (lease_expires_at, run_seq) ON agent_task_steps TO app_system;
--> statement-breakpoint

-- 3. pg-boss connects as app_system and runs `CREATE SCHEMA IF NOT EXISTS pgboss` when it starts.
--    Postgres checks CREATE on the database before it looks for the schema, so the statement needs
--    the privilege even though 0002 already made the schema (owned by app_system). The database's
--    name differs between environments, hence the dynamic GRANT.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO app_system', current_database());
END
$$;
