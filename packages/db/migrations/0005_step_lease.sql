-- A step's run lease (the runner's dead-claim recovery). The claim sets lease_expires_at to ten
-- minutes ahead and the end of the run clears it. A `running` step whose lease has passed was left
-- behind by a run that died, so the sweeper puts it back in the queue; a `running` step with no lease
-- is parked (it finishes by itself later) and is left alone. app_tenant's table-level grants cover
-- the new column; app_system's column-level SELECT does not (the sweeper's fan-out adds it when it
-- needs it).
ALTER TABLE "agent_task_steps" ADD COLUMN "lease_expires_at" timestamp with time zone;
