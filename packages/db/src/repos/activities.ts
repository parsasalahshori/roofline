import { and, count, desc, eq } from 'drizzle-orm';
import type { ActivitySubjectType } from '@roofline/shared';
import { activities, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { clampPage } from './paging.ts';
import { customerScope } from './scope.ts';

export type ActivityRow = typeof activities.$inferSelect;

export type ActivityEntry = {
  subjectType: ActivitySubjectType;
  subjectId: string;
  /** What happened, dotted: `customer.created`, `customer.updated`, `customer.consent_changed`, `customer.archived`. */
  kind: string;
  /** A plain-English line for the timeline. */
  summary: string;
  data?: Record<string, unknown>;
  /** When it happened. Pass the app clock's `now()`; the database's own clock is the fallback. */
  at?: Date;
  /** Set when an agent (not a person) did it. The context's user is then not recorded as the actor. */
  actorAgent?: string;
};

/**
 * Appends one line to the timeline of a customer, property or job. Runs inside the caller's
 * `withTenant` transaction, so the line is saved with the change it describes or not at all.
 * The actor is the context's signed-in user; with none (the runner and the scheduler) it is 'system',
 * or 'agent' when `actorAgent` names one.
 */
export async function addActivity(tx: Tx, ctx: TenantContext, entry: ActivityEntry): Promise<void> {
  const byAgent = entry.actorAgent !== undefined;
  await tx.insert(activities).values({
    companyId: ctx.companyId,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId,
    kind: entry.kind,
    summary: entry.summary,
    ...(entry.data !== undefined && { data: entry.data }),
    actorType: byAgent ? 'agent' : ctx.userId !== null ? 'user' : 'system',
    actorUserId: byAgent ? null : ctx.userId,
    actorAgent: entry.actorAgent ?? null,
    ...(entry.at !== undefined && { at: entry.at }),
  });
}

/**
 * Whether the member may see the timeline of this subject: it must exist in their company and, for
 * a customer, be inside their scope. A rep gets no property or job timelines yet (Task 11 widens
 * that to the ones linked to a job they can see); the owner and the office get all of them.
 */
async function activitySubjectVisible(
  tx: Tx,
  ctx: TenantContext,
  subjectType: ActivitySubjectType,
  subjectId: string,
): Promise<boolean> {
  if (subjectType === 'customer') {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, subjectId), customerScope(ctx)))
      .limit(1);
    return row !== undefined;
  }
  if (ctx.role === 'rep') return false;
  const table = subjectType === 'property' ? properties : jobs;
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, subjectId)).limit(1);
  return row !== undefined;
}

export type ListActivitiesOptions = {
  subjectType: ActivitySubjectType;
  subjectId: string;
  limit?: number;
  offset?: number;
};

/**
 * A subject's timeline, newest first, with the total count; null when the member may not see the
 * subject (it is not in their company or their scope, or does not exist).
 */
export async function listActivities(
  tx: Tx,
  ctx: TenantContext,
  options: ListActivitiesOptions,
): Promise<{ activities: ActivityRow[]; total: number } | null> {
  if (!(await activitySubjectVisible(tx, ctx, options.subjectType, options.subjectId))) return null;
  const { limit, offset } = clampPage(options);
  const where = and(eq(activities.subjectType, options.subjectType), eq(activities.subjectId, options.subjectId));
  const rows = await tx
    .select()
    .from(activities)
    .where(where)
    // `at` is the app clock's time of the event; created_at and id only break ties deterministically.
    .orderBy(desc(activities.at), desc(activities.createdAt), desc(activities.id))
    .limit(limit)
    .offset(offset);
  const [totals] = await tx.select({ total: count() }).from(activities).where(where);
  return { activities: rows, total: totals?.total ?? 0 };
}
