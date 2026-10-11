import { randomUUID } from 'node:crypto';
import { and, asc, countDistinct, desc, eq, getTableColumns, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { Agent, ApprovalClass, StepStatus, TaskStatus } from '@roofline/shared';
import { agentTasks, agentTaskSteps, companies, customers } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { clampPage } from './paging.ts';

/*
 * Data access for the approval queue (spec 4.1): agent tasks and their steps. Everything here runs
 * inside `withTenant`, so row-level security keeps it to the member's company; each query also
 * names the company, so it never depends on that alone. What a step means (its payload rules, its
 * preview) lives in `@roofline/shared`'s registry and in the API's task service; this file only
 * reads and writes rows.
 */

export type TaskRow = typeof agentTasks.$inferSelect;
export type StepRow = typeof agentTaskSteps.$inferSelect;

/** A step without its payload: what lists show. A payload can hold thousands of customer ids, so lists never read it. */
export type StepSummaryRow = Omit<StepRow, 'payload'>;

// The destructured `payload` is the one column left out of the list.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { payload: _payload, ...SUMMARY_COLUMNS } = getTableColumns(agentTaskSteps);

/** One step of a new task. The caller (the service) has already checked the payload and built the preview. */
export type NewStepRow = {
  type: string;
  approvalClass: ApprovalClass;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
};

export type NewTaskRow = {
  agent: Agent;
  kind: string;
  title: string;
  summary?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  mode?: 'needs_approval' | 'live';
  expiresAt?: Date | null;
  /** In order: the first is position 0. */
  steps: NewStepRow[];
};

/** The company's display name (the one a text names), or null if the context's company cannot be seen. */
export async function getCompanyName(tx: Tx, ctx: TenantContext): Promise<string | null> {
  const [row] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.name ?? null;
}

/**
 * Which of these customers exist in the company, with their first names (null when a customer has
 * none). A customer that does not exist, or belongs to another company, is simply missing from the
 * map. Archived customers still exist.
 */
export async function customerFirstNames(
  tx: Tx,
  ctx: TenantContext,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: customers.id, firstName: customers.firstName })
    .from(customers)
    .where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, [...ids])));
  return new Map(rows.map((r) => [r.id, r.firstName]));
}

/**
 * Saves a new task as a draft, with its steps `pending`, `enabled`, at version 1, each with a fresh
 * idempotency key (the key a step's messages and charges carry, so a retry never repeats them).
 * `now` is the app clock's time for the new rows.
 */
export async function insertTask(tx: Tx, ctx: TenantContext, input: NewTaskRow, now: Date): Promise<{ taskId: string }> {
  const [task] = await tx
    .insert(agentTasks)
    .values({
      companyId: ctx.companyId,
      agent: input.agent,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      mode: input.mode ?? 'needs_approval',
      status: 'draft',
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: agentTasks.id });
  const taskId = task!.id;

  if (input.steps.length > 0) {
    await tx.insert(agentTaskSteps).values(
      input.steps.map((step, position) => ({
        companyId: ctx.companyId,
        taskId,
        position,
        type: step.type,
        approvalClass: step.approvalClass,
        enabled: true,
        version: 1,
        payload: step.payload,
        preview: step.preview,
        status: 'pending' as const,
        idempotencyKey: randomUUID(),
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })),
    );
  }
  return { taskId };
}

/** The company's tasks in any of these statuses, newest first. */
export async function listTasksByStatus(tx: Tx, ctx: TenantContext, statuses: readonly TaskStatus[]): Promise<TaskRow[]> {
  if (statuses.length === 0) return [];
  return tx
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), inArray(agentTasks.status, [...statuses])))
    .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id));
}

/** One task, or null. `forUpdate` locks its row until the transaction ends (the order approve and edit both take: task first, then steps). */
export async function getTask(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  options: { forUpdate?: boolean } = {},
): Promise<TaskRow | null> {
  const query = tx
    .select()
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.id, taskId)))
    .limit(1);
  const [row] = await (options.forUpdate === true ? query.for('update') : query);
  return row ?? null;
}

/**
 * The steps of these tasks, each task's steps in position order. By default without the payload
 * (lists never read it: a batch can hold thousands of customer ids); `{ payload: true }` reads it
 * too, for the one task a person opens.
 */
export async function listSteps(tx: Tx, ctx: TenantContext, taskIds: readonly string[], options: { payload: true }): Promise<StepRow[]>;
export async function listSteps(tx: Tx, ctx: TenantContext, taskIds: readonly string[]): Promise<StepSummaryRow[]>;
export async function listSteps(
  tx: Tx,
  ctx: TenantContext,
  taskIds: readonly string[],
  options: { payload?: boolean } = {},
): Promise<StepRow[] | StepSummaryRow[]> {
  if (taskIds.length === 0) return [];
  const where = and(eq(agentTaskSteps.companyId, ctx.companyId), inArray(agentTaskSteps.taskId, [...taskIds]));
  const order = [asc(agentTaskSteps.taskId), asc(agentTaskSteps.position)] as const;
  if (options.payload === true) return tx.select().from(agentTaskSteps).where(where).orderBy(...order);
  return tx.select(SUMMARY_COLUMNS).from(agentTaskSteps).where(where).orderBy(...order);
}

/** One step of one task, with its payload, or null. */
export async function getStep(tx: Tx, ctx: TenantContext, taskId: string, stepId: string): Promise<StepRow | null> {
  const [row] = await tx
    .select()
    .from(agentTaskSteps)
    .where(
      and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.taskId, taskId), eq(agentTaskSteps.id, stepId)),
    )
    .limit(1);
  return row ?? null;
}

export type StepEdit = {
  enabled?: boolean;
  payload?: Record<string, unknown>;
  preview?: Record<string, unknown>;
};

/**
 * Applies an edit to a step that is still `pending` and still at `version`; the version goes up by
 * one and the editor and time are recorded. Returns the new row, or null when the step is no longer
 * pending or no longer at that version (someone else got there first). The version check is part of
 * the UPDATE itself, so two edits with the same version can never both succeed even if the caller
 * forgot to lock.
 */
export async function updatePendingStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  version: number,
  edit: StepEdit,
  now: Date,
): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({
      ...(edit.enabled !== undefined && { enabled: edit.enabled }),
      ...(edit.payload !== undefined && { payload: edit.payload }),
      ...(edit.preview !== undefined && { preview: edit.preview }),
      version: sql`${agentTaskSteps.version} + 1`,
      editedByUserId: ctx.userId,
      editedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.id, stepId),
        eq(agentTaskSteps.version, version),
        eq(agentTaskSteps.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------
// Approving, declining and running

/** The task columns approving, declining and finishing change. */
export type TaskUpdate = Partial<
  Pick<
    TaskRow,
    'status' | 'approvedByUserId' | 'approvedAt' | 'declinedByUserId' | 'declinedAt' | 'declineReason' | 'minutesSaved'
  >
>;

/** Changes a task's status (and what goes with it). Returns the row as saved, or null when the task is not there. */
export async function updateTask(tx: Tx, ctx: TenantContext, taskId: string, set: TaskUpdate, now: Date): Promise<TaskRow | null> {
  const [row] = await tx
    .update(agentTasks)
    .set({ ...set, updatedAt: now })
    .where(and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.id, taskId)))
    .returning();
  return row ?? null;
}

/** Where a step moves to, and what is recorded with the move. */
export type StepMove = {
  status: StepStatus;
  approvedByUserId?: string | null;
  approvedAt?: Date | null;
  attempts?: number;
  errorPlain?: string | null;
};

/**
 * Moves one step to another status, but only while it is still in one of `from`. Returns the row
 * as saved, or null when the step is in some other status by now. The status check is part of the
 * UPDATE, so a step that already moved on is never moved a second time.
 */
export async function moveStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  from: readonly StepStatus[],
  to: StepMove,
  now: Date,
): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({ ...to, updatedAt: now })
    .where(
      and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.id, stepId), inArray(agentTaskSteps.status, [...from])),
    )
    .returning();
  return row ?? null;
}

/**
 * The runner's claim on a step:
 * `UPDATE agent_task_steps SET status = 'running', attempts = attempts + 1, lease_expires_at = <lease>
 *  WHERE id = $1 AND company_id = $2 AND status = 'queued' RETURNING *`.
 * Only a `queued` step is claimed, so a second delivery of a step that is already running (or
 * parked) does nothing. The lease says how long this run owns the step; when a run dies, the
 * sweeper (`reclaimExpiredLeases`) puts the step back once the lease has passed. Returns null when
 * the step is not there to run (not approved, running, finished, or not this company's).
 */
export async function claimStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  now: Date,
  leaseExpiresAt: Date,
): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({ status: 'running', attempts: sql`${agentTaskSteps.attempts} + 1`, leaseExpiresAt, updatedAt: now })
    .where(
      and(eq(agentTaskSteps.companyId, ctx.companyId), eq(agentTaskSteps.id, stepId), eq(agentTaskSteps.status, 'queued')),
    )
    .returning();
  return row ?? null;
}

/**
 * How a run ended, as the step saves it:
 * - `done`, `failed`, `needs_attention`: finished (the last two with a reason a person can read);
 * - `running`: parked, finishing by itself later (no lease, so the sweeper leaves it alone);
 * - `queued`: back in the queue after a throw, for the queue's next try.
 */
export type StepFinish = {
  status: 'done' | 'running' | 'failed' | 'needs_attention' | 'queued';
  result?: Record<string, unknown>;
  errorPlain?: string | null;
};

/**
 * Saves how a run ended, if the step is still that run's: `running` at the run's `attempts` (a
 * newer claim has a higher count). Clears the lease. Returns the row as saved, or null for a
 * stale run, which then writes nothing. One plain UPDATE: the row lock it takes is FOR NO KEY
 * UPDATE, so it never blocks a handler's own inserts that reference the step.
 */
export async function finishClaimedStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  attempts: number,
  finish: StepFinish,
  now: Date,
): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({
      status: finish.status,
      ...(finish.result !== undefined && { result: finish.result }),
      errorPlain: finish.errorPlain ?? null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.id, stepId),
        eq(agentTaskSteps.status, 'running'),
        eq(agentTaskSteps.attempts, attempts),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * The sweeper's dead-claim recovery, for one company: every `running` step whose lease has passed
 * (`lease_expires_at < now`) was left behind by a run that died, so it goes back to `queued` with
 * no lease. Its attempts are kept (the dead run counted). A running step with no lease is parked
 * and left alone, as is one whose lease has not passed. Returns the ids put back, for the caller
 * to hand to the queue after it commits.
 */
export async function reclaimExpiredLeases(tx: Tx, ctx: TenantContext, now: Date): Promise<string[]> {
  const rows = await tx
    .update(agentTaskSteps)
    .set({ status: 'queued', leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.status, 'running'),
        isNotNull(agentTaskSteps.leaseExpiresAt),
        lt(agentTaskSteps.leaseExpiresAt, now),
      ),
    )
    .returning({ id: agentTaskSteps.id });
  return rows.map((r) => r.id);
}

/**
 * A person's retry: puts a step that did not finish back in the queue with its attempts at 0, no
 * error and no lease, keeping its idempotency key. "Did not finish" is `failed`, `needs_attention`,
 * or `running` past its lease (a run that died before the sweeper got to it). Returns null when the
 * step is in none of those by now.
 */
export async function requeueForRetry(tx: Tx, ctx: TenantContext, stepId: string, now: Date): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({ status: 'queued', attempts: 0, errorPlain: null, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.id, stepId),
        or(
          inArray(agentTaskSteps.status, ['failed', 'needs_attention']),
          and(
            eq(agentTaskSteps.status, 'running'),
            isNotNull(agentTaskSteps.leaseExpiresAt),
            lt(agentTaskSteps.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  return row ?? null;
}

export type ListTasksOptions = {
  agent?: Agent;
  status?: TaskStatus;
  /** Only tasks created at this time or later. */
  since?: Date;
  /** 1 to 200; 50 when not given. */
  limit?: number;
};

/** The company's tasks in any status, newest first, optionally narrowed (the activity feed). */
export async function listTasks(tx: Tx, ctx: TenantContext, options: ListTasksOptions = {}): Promise<TaskRow[]> {
  const { limit } = clampPage({ ...(options.limit !== undefined && { limit: options.limit }) });
  return tx
    .select()
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        options.agent !== undefined ? eq(agentTasks.agent, options.agent) : undefined,
        options.status !== undefined ? eq(agentTasks.status, options.status) : undefined,
        options.since !== undefined ? gte(agentTasks.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(agentTasks.createdAt), desc(agentTasks.id))
    .limit(limit);
}

/** How many of the company's tasks have a step being worked on (`queued` or `running`): the "agents working" number. */
export async function countWorkingTasks(tx: Tx, ctx: TenantContext): Promise<number> {
  const [row] = await tx
    .select({ n: countDistinct(agentTaskSteps.taskId) })
    .from(agentTaskSteps)
    .where(and(eq(agentTaskSteps.companyId, ctx.companyId), inArray(agentTaskSteps.status, ['queued', 'running'])));
  return row?.n ?? 0;
}
