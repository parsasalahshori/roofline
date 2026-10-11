import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import type { Agent, ApprovalClass, TaskStatus } from '@roofline/shared';
import { agentTasks, agentTaskSteps, companies, customers } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

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

/** The steps of these tasks, without payloads, each task's steps in position order. */
export async function listSteps(tx: Tx, ctx: TenantContext, taskIds: readonly string[]): Promise<StepSummaryRow[]> {
  if (taskIds.length === 0) return [];
  return tx
    .select(SUMMARY_COLUMNS)
    .from(agentTaskSteps)
    .where(and(eq(agentTaskSteps.companyId, ctx.companyId), inArray(agentTaskSteps.taskId, [...taskIds])))
    .orderBy(asc(agentTaskSteps.taskId), asc(agentTaskSteps.position));
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
