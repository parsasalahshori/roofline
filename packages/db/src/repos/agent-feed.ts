import { and, desc, eq, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import type { Agent } from '@roofline/shared';
import { agentTaskEvents, agentTasks, agentTaskSteps, customers, jobs, users } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import type { AgentEventKind } from './agent-events.ts';
import { customerScope, jobScope } from './scope.ts';

/*
 * The agents feed read side: events joined to their task, step, subject and approver, role-scoped.
 * Every table is filtered by the company as well as by row-level security. Rows carry counts and
 * ids only (`data`, `stepResult`); no payload, preview or message body is ever selected here.
 */

export type FeedCursor = { at: Date; id: string };

/** One event row for the feed. Names are joined at read time and are null when the reader may not see them. */
export type FeedRow = {
  id: string;
  taskId: string;
  agent: Agent;
  kind: AgentEventKind;
  at: Date;
  /** Counts and ids only. */
  data: Record<string, unknown>;
  taskKind: string;
  taskTitle: string;
  taskStatus: string;
  subjectType: string | null;
  subjectId: string | null;
  /** The step this event is about (step_* events), else null. */
  stepType: string | null;
  /** That step's stored result (counts only), else null. */
  stepResult: Record<string, unknown> | null;
  /** Full name of the user who acted (approved/declined), else null. */
  actorName: string | null;
  /** First name of the customer the subject is (or the job is for), only when inside customerScope(ctx), else null. */
  customerFirstName: string | null;
};

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

/** A scope condition, or "true" when the reader sees everything (the owner and the office). */
const orAll = (condition: SQL | undefined): SQL => condition ?? sql`true`;

/**
 * Reps see an event only when its task's subject is a job they may see or a customer they may see.
 * A task with no subject is not visible to a rep. Owners and the office get no condition.
 */
function repScope(ctx: TenantContext): SQL | undefined {
  if (ctx.role !== 'rep') return undefined;
  return or(
    and(
      eq(agentTasks.subjectType, 'job'),
      sql`${agentTasks.subjectId} in (select ${jobs.id} from ${jobs} where ${orAll(and(eq(jobs.companyId, ctx.companyId), jobScope(ctx)))})`,
    ),
    and(
      eq(agentTasks.subjectType, 'customer'),
      sql`${agentTasks.subjectId} in (select ${customers.id} from ${customers} where ${orAll(and(eq(customers.companyId, ctx.companyId), customerScope(ctx)))})`,
    ),
  );
}

/**
 * Newest first by (at desc, id desc); returns at most `limit` rows after `cursor` (exclusive).
 * `agent` filters on the task's agent. Reps only see subject_type 'job' inside jobScope(ctx) or
 * 'customer' inside customerScope(ctx). Company B never appears.
 */
export async function listFeedPage(
  tx: Tx,
  ctx: TenantContext,
  options: { agent?: Agent; cursor?: FeedCursor | null; limit: number },
): Promise<FeedRow[]> {
  const requested = Number.isFinite(options.limit) ? Math.floor(options.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested));
  const cursor = options.cursor ?? null;

  const rows = await tx
    .select({
      id: agentTaskEvents.id,
      taskId: agentTaskEvents.taskId,
      agent: agentTasks.agent,
      kind: agentTaskEvents.kind,
      at: agentTaskEvents.at,
      data: agentTaskEvents.data,
      taskKind: agentTasks.kind,
      taskTitle: agentTasks.title,
      taskStatus: agentTasks.status,
      subjectType: agentTasks.subjectType,
      subjectId: agentTasks.subjectId,
      stepType: agentTaskSteps.type,
      stepResult: agentTaskSteps.result,
      actorName: users.name,
    })
    .from(agentTaskEvents)
    .innerJoin(
      agentTasks,
      and(eq(agentTasks.companyId, agentTaskEvents.companyId), eq(agentTasks.id, agentTaskEvents.taskId)),
    )
    .leftJoin(
      agentTaskSteps,
      and(eq(agentTaskSteps.companyId, agentTaskEvents.companyId), eq(agentTaskSteps.id, agentTaskEvents.stepId)),
    )
    .leftJoin(users, eq(users.id, agentTaskEvents.actorUserId))
    .where(
      and(
        eq(agentTaskEvents.companyId, ctx.companyId),
        eq(agentTasks.companyId, ctx.companyId),
        options.agent ? eq(agentTasks.agent, options.agent) : undefined,
        cursor
          ? or(
              lt(agentTaskEvents.at, cursor.at),
              and(eq(agentTaskEvents.at, cursor.at), lt(agentTaskEvents.id, cursor.id)),
            )
          : undefined,
        repScope(ctx),
      ),
    )
    .orderBy(desc(agentTaskEvents.at), desc(agentTaskEvents.id))
    .limit(limit);

  // The customer each row is about: the subject customer, or the customer of the subject job.
  const jobIds = [...new Set(rows.filter((r) => r.subjectType === 'job' && r.subjectId).map((r) => r.subjectId!))];
  const jobCustomer = new Map<string, string>();
  if (jobIds.length > 0) {
    const jobRows = await tx
      .select({ id: jobs.id, customerId: jobs.customerId })
      .from(jobs)
      .where(and(eq(jobs.companyId, ctx.companyId), inArray(jobs.id, jobIds)));
    for (const j of jobRows) jobCustomer.set(j.id, j.customerId);
  }

  const customerOf = (r: (typeof rows)[number]): string | null => {
    if (!r.subjectId) return null;
    if (r.subjectType === 'customer') return r.subjectId;
    if (r.subjectType === 'job') return jobCustomer.get(r.subjectId) ?? null;
    return null;
  };

  // First names are read only for customers the reader may see.
  const customerIds = [...new Set(rows.map(customerOf).filter((id): id is string => id !== null))];
  const firstNames = new Map<string, string | null>();
  if (customerIds.length > 0) {
    const customerRows = await tx
      .select({ id: customers.id, firstName: customers.firstName })
      .from(customers)
      .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, customerIds), customerScope(ctx)));
    for (const c of customerRows) firstNames.set(c.id, c.firstName);
  }

  return rows.map((r) => {
    const customerId = customerOf(r);
    return {
      id: r.id,
      taskId: r.taskId,
      agent: r.agent,
      kind: r.kind,
      at: r.at,
      data: r.data,
      taskKind: r.taskKind,
      taskTitle: r.taskTitle,
      taskStatus: r.taskStatus,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      stepType: r.stepType,
      stepResult: r.stepResult,
      actorName: r.actorName,
      customerFirstName: customerId !== null ? (firstNames.get(customerId) ?? null) : null,
    };
  });
}
