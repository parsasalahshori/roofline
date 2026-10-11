import { randomUUID } from 'node:crypto';
import { and, asc, countDistinct, desc, eq, getTableColumns, gte, inArray, sql } from 'drizzle-orm';
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
 * `UPDATE agent_task_steps SET status = 'running', attempts = attempts + 1 WHERE id = $1 AND status IN ('queued', 'running') RETURNING *`.
 * A step that is still `running` is claimed again, so one left behind by a run that crashed is picked
 * up by the queue's next try, and that try is counted. Returns null when the step is not there to run
 * (not approved, already finished, or not this company's).
 */
export async function claimStep(tx: Tx, ctx: TenantContext, stepId: string, now: Date): Promise<StepRow | null> {
  const [row] = await tx
    .update(agentTaskSteps)
    .set({ status: 'running', attempts: sql`${agentTaskSteps.attempts} + 1`, updatedAt: now })
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.id, stepId),
        inArray(agentTaskSteps.status, ['queued', 'running']),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Locks a step for the run that claimed it: the row, if it is still `running` at that run's
 * `attempts` (a later claim of the same step, by a queue that ran it twice, has a higher count and
 * takes over). Null means the run no longer owns the step.
 */
export async function lockClaimedStep(tx: Tx, ctx: TenantContext, stepId: string, attempts: number): Promise<StepRow | null> {
  const [row] = await tx
    .select()
    .from(agentTaskSteps)
    .where(
      and(
        eq(agentTaskSteps.companyId, ctx.companyId),
        eq(agentTaskSteps.id, stepId),
        eq(agentTaskSteps.status, 'running'),
        eq(agentTaskSteps.attempts, attempts),
      ),
    )
    .limit(1)
    .for('update');
  return row ?? null;
}

/** How a run ended, as the step saves it. */
export type StepFinish = {
  status: 'done' | 'running' | 'failed' | 'needs_attention';
  result?: Record<string, unknown>;
  errorPlain?: string | null;
};

/**
 * Saves how a run ended, if the step is still that run's: `running` at the run's `attempts`.
 * Returns the row as saved, or null when another run has taken the step over.
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
