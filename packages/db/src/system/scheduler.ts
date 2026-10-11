import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../pools.ts';
import { agentTasks, agentTaskSteps } from '../schema/index.ts';

/*
 * The scheduler's fan-out. These run on the app_system pool, which bypasses row-level security but
 * may read only a few columns of the tenant tables (ids, company, status and timing; never
 * content). They only LIST what needs doing, across companies: the work itself is done per company
 * by the caller, inside `withTenant`, as app_tenant and under RLS. Only apps/api/src/jobs/scheduler/**
 * (and the worker) import this module. Callers pass `now`, so the app's clock decides every cut-off.
 */

/** The companies that have a draft whose time ran out (`expires_at < now`), each once. */
export async function companiesWithExpiredDrafts(system: Db, now: Date): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: agentTasks.companyId })
    .from(agentTasks)
    .where(and(eq(agentTasks.status, 'draft'), isNotNull(agentTasks.expiresAt), lt(agentTasks.expiresAt, now)))
    .orderBy(asc(agentTasks.companyId));
  return rows.map((r) => r.companyId);
}

/**
 * The steps that have been `queued` for longer than `ms` (their last change was before
 * `now - ms`), with their companies, oldest first. A step is queued only for as long as it takes
 * a worker to pick it up, so one still queued after a while was most likely never handed to the
 * queue (the send failed after the approval had committed) or its job was lost.
 */
export async function stepsQueuedLongerThan(system: Db, ms: number, now: Date): Promise<{ companyId: string; stepId: string }[]> {
  return system
    .select({ companyId: agentTaskSteps.companyId, stepId: agentTaskSteps.id })
    .from(agentTaskSteps)
    .where(and(eq(agentTaskSteps.status, 'queued'), lt(agentTaskSteps.updatedAt, new Date(now.getTime() - ms))))
    .orderBy(asc(agentTaskSteps.updatedAt), asc(agentTaskSteps.id));
}

/**
 * The companies that have a `running` step whose run lease has passed (a run that died), each
 * once. A running step with no lease is parked (it finishes by itself later) and never counts.
 */
export async function companiesWithExpiredLeases(system: Db, now: Date): Promise<string[]> {
  const rows = await system
    .selectDistinct({ companyId: agentTaskSteps.companyId })
    .from(agentTaskSteps)
    .where(
      and(
        eq(agentTaskSteps.status, 'running'),
        isNotNull(agentTaskSteps.leaseExpiresAt),
        lt(agentTaskSteps.leaseExpiresAt, now),
      ),
    )
    .orderBy(asc(agentTaskSteps.companyId));
  return rows.map((r) => r.companyId);
}
