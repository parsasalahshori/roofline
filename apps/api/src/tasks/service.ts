import {
  audit,
  customerFirstNames,
  getCompanyName,
  getStep,
  getTask,
  insertTask,
  listSteps,
  listTasksByStatus,
  type NewStepRow,
  type StepSummaryRow,
  type TaskRow,
  type TenantContext,
  type Tx,
  updatePendingStep,
  type WriteOptions,
} from '@roofline/db';
import {
  type Agent,
  type ApprovalClass,
  isStepType,
  type PreviewFacts,
  type StepStatus,
  type StepType,
  stepTypes,
  type TaskStatus,
} from '@roofline/shared';
import { AppError, MESSAGES } from '../errors.ts';
import { can, type Capability } from '../permissions.ts';

/*
 * The approval queue's rules (spec 4.1): how an agent's task is made, who sees it, and how a
 * person edits one of its steps before approving. The data access is packages/db's repos/tasks.ts;
 * what a step type needs is packages/shared's registry (steps.ts). Approving, declining and
 * running come in the next tasks and live next to this.
 */

const NO_CUSTOMERS = "Some of these customers don't exist.";

/** The capability a person needs to approve (and so to edit or switch off) a step of each class. */
const APPROVE: Record<ApprovalClass, Capability> = {
  message: 'approve_message',
  internal: 'approve_internal',
  spend: 'approve_spend',
};

// ---------------------------------------------------------------------------------------------
// Who sees the queue

/**
 * Whether someone works the approval queue at all: the owner and the office. A rep has no approve
 * capability, so every approvals route answers them as if there were nothing there (an empty list,
 * or a 404 for one task), and a rep cannot learn that a task exists.
 */
export function canReview(ctx: TenantContext): boolean {
  return can(ctx, 'approve_message') || can(ctx, 'approve_internal') || can(ctx, 'approve_spend');
}

// ---------------------------------------------------------------------------------------------
// Views

/** One step as the review screen gets it. The payload is left out: a batch can hold thousands of customer ids. */
export type StepView = {
  id: string;
  position: number;
  type: string;
  approvalClass: ApprovalClass;
  enabled: boolean;
  version: number;
  status: StepStatus;
  preview: Record<string, unknown>;
  /** Whether the viewer may approve (and so edit) this step. */
  canApprove: boolean;
};

export type TaskView = {
  id: string;
  agent: Agent;
  kind: string;
  title: string;
  summary: string | null;
  status: TaskStatus;
  createdAt: Date;
  expiresAt: Date | null;
  /** True for a plan whose time has run out: marked `expired`, or a draft past `expiresAt` that the expiry job has not reached yet. */
  expired: boolean;
  steps: StepView[];
};

export function toStepView(row: StepSummaryRow, ctx: TenantContext): StepView {
  return {
    id: row.id,
    position: row.position,
    type: row.type,
    approvalClass: row.approvalClass,
    enabled: row.enabled,
    version: row.version,
    status: row.status,
    preview: row.preview,
    canApprove: can(ctx, APPROVE[row.approvalClass]),
  };
}

/**
 * A plan that can no longer be approved because its time ran out. The expiry job flips a draft to
 * `expired` a few minutes after `expiresAt`; until it does, a draft past its time reads as expired
 * here, so the screen never offers an approval that is about to disappear. Only drafts expire: a
 * plan that is already partly approved is waiting on the owner, not on the clock.
 */
export function isExpired(task: Pick<TaskRow, 'status' | 'expiresAt'>, now: Date): boolean {
  if (task.status === 'expired') return true;
  return task.status === 'draft' && task.expiresAt !== null && task.expiresAt.getTime() < now.getTime();
}

export function toTaskView(task: TaskRow, steps: StepSummaryRow[], ctx: TenantContext, now: Date): TaskView {
  return {
    id: task.id,
    agent: task.agent,
    kind: task.kind,
    title: task.title,
    summary: task.summary,
    status: task.status,
    createdAt: task.createdAt,
    expiresAt: task.expiresAt,
    expired: isExpired(task, now),
    steps: steps.map((step) => toStepView(step, ctx)),
  };
}

// ---------------------------------------------------------------------------------------------
// Payloads

/** Not the company's to read, or not there at all: cannot happen to a signed-in member, so it is a fault, not a 4xx. */
async function companyNameOf(tx: Tx, ctx: TenantContext): Promise<string> {
  const name = await getCompanyName(tx, ctx);
  if (name === null) throw new Error('The company of this context cannot be read.');
  return name;
}

/** What a step's preview needs that the payload alone does not say. Today only a text batch looks anything up. */
async function previewFacts(
  tx: Tx,
  ctx: TenantContext,
  type: StepType,
  payload: unknown,
  companyName: string,
  field: string,
): Promise<PreviewFacts> {
  if (type !== 'send_sms_batch') return { companyName };
  const { customerIds } = payload as { customerIds: string[] };
  const firstNames = await customerFirstNames(tx, ctx, customerIds);
  if (customerIds.some((id) => !firstNames.has(id))) throw new AppError(400, NO_CUSTOMERS, `${field}.customerIds`);
  return {
    companyName,
    recipientCount: customerIds.length,
    // The first customer listed, whatever order the database would give them back in.
    sampleFirstName: firstNames.get(customerIds[0]!) ?? '',
  };
}

/**
 * Runs a payload through its step type: the shape (with the schema's plain messages), the step
 * type's own rule, and the customers it names; then builds the preview. Throws a 400 whose `field`
 * is the one given (`steps.1.payload`, or `payload` on an edit). Returns the payload as parsed
 * (trimmed, ids in lowercase), which is what gets saved.
 */
async function checkPayload(
  tx: Tx,
  ctx: TenantContext,
  type: StepType,
  raw: unknown,
  companyName: string,
  field: string,
): Promise<{ payload: Record<string, unknown>; preview: Record<string, unknown> }> {
  const def = stepTypes[type];
  // The schemas carry their own plain sentences; zod's default wording is replaced by the generic one.
  const result = def.payload.safeParse(raw, { error: () => MESSAGES.checkField });
  if (!result.success) throw new AppError(400, result.error.issues[0]?.message ?? MESSAGES.checkField, field);
  const payload = result.data as Record<string, unknown>;

  const problem = def.validate?.(payload, { companyName }) ?? null;
  if (problem !== null) throw new AppError(400, problem, field);

  const facts = await previewFacts(tx, ctx, type, payload, companyName, field);
  return { payload, preview: { ...def.preview(payload, facts) } };
}

// ---------------------------------------------------------------------------------------------
// Making a task

export type NewTask = {
  agent: Agent;
  kind: string;
  title: string;
  summary?: string;
  subjectType?: string;
  subjectId?: string;
  expiresAt?: Date;
  mode?: 'needs_approval' | 'live';
  steps: { type: StepType; payload: unknown }[];
};

/**
 * Makes a draft task with its steps, for an agent. This is the service the agents and the demo seed
 * call; no HTTP route creates tasks.
 * - Each step's payload is checked by its step type, so a bad one is a 400 on `steps.N.payload`
 *   (a text to customers that do not exist is one on `steps.N.payload.customerIds`) and nothing is saved.
 * - The approval class comes from the step type, never from the agent.
 * - Steps start `pending`, enabled, at version 1, with a new idempotency key each; the task is a `draft`.
 * - The preview each step shows is built here, from the checked payload.
 * Runs in the caller's `withTenant` transaction.
 */
export async function createTask(tx: Tx, ctx: TenantContext, input: NewTask, opts: WriteOptions): Promise<{ taskId: string }> {
  if (input.steps.length === 0) throw new AppError(400, 'A plan needs at least one step.', 'steps');

  const companyName = await companyNameOf(tx, ctx);
  const steps: NewStepRow[] = [];
  for (const [n, step] of input.steps.entries()) {
    if (!isStepType(step.type)) throw new AppError(400, "That kind of step isn't supported.", `steps.${n}.type`);
    const checked = await checkPayload(tx, ctx, step.type, step.payload, companyName, `steps.${n}.payload`);
    steps.push({ type: step.type, approvalClass: stepTypes[step.type].approvalClass, ...checked });
  }

  const { taskId } = await insertTask(
    tx,
    ctx,
    {
      agent: input.agent,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      ...(input.mode !== undefined && { mode: input.mode }),
      expiresAt: input.expiresAt ?? null,
      steps,
    },
    opts.now,
  );
  await audit(tx, ctx, {
    action: 'task.create',
    targetType: 'agent_task',
    targetId: taskId,
    after: { agent: input.agent, kind: input.kind, title: input.title, steps: steps.map((s) => s.type) },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return { taskId };
}

// ---------------------------------------------------------------------------------------------
// Reading the queue

/**
 * The tasks waiting on this member, newest first, as `{ count, tasks }` (`count` is what the "N need
 * your OK" pill shows). The owner, and office staff the owner has let approve spend, see drafts and
 * the plans waiting on the owner; other office staff see drafts only; a rep sees nothing.
 * A draft past its time is still listed, marked `expired`, until the expiry job moves it.
 */
export async function listApprovals(tx: Tx, ctx: TenantContext, now: Date): Promise<{ count: number; tasks: TaskView[] }> {
  if (!canReview(ctx)) return { count: 0, tasks: [] };
  const statuses: TaskStatus[] = can(ctx, 'approve_spend') ? ['draft', 'awaiting_owner'] : ['draft'];
  const tasks = await listTasksByStatus(tx, ctx, statuses);
  const steps = await listSteps(
    tx,
    ctx,
    tasks.map((task) => task.id),
  );
  // listSteps gives each task's steps in position order; keep that order within the group.
  const byTask = new Map<string, StepSummaryRow[]>();
  for (const step of steps) byTask.set(step.taskId, [...(byTask.get(step.taskId) ?? []), step]);
  const views = tasks.map((task) => toTaskView(task, byTask.get(task.id) ?? [], ctx, now));
  return { count: views.length, tasks: views };
}

/** One task in any status (the screen shows how a plan ended, too), or null for a rep, an unknown id or another company's. */
export async function getApproval(tx: Tx, ctx: TenantContext, taskId: string, now: Date): Promise<TaskView | null> {
  if (!canReview(ctx)) return null;
  const task = await getTask(tx, ctx, taskId);
  if (!task) return null;
  return toTaskView(task, await listSteps(tx, ctx, [task.id]), ctx, now);
}

// ---------------------------------------------------------------------------------------------
// Editing a step

export type StepEditInput = {
  /** The version the editor was looking at. */
  version: number;
  enabled?: boolean;
  payload?: Record<string, unknown>;
};

/** The screen was showing something that is out of date: 409 with the step as it is now. */
function changed(step: StepSummaryRow, ctx: TenantContext): AppError {
  return new AppError(409, MESSAGES.changedWhileLooking, undefined, toStepView(step, ctx));
}

/**
 * Edits one step of a draft before it is approved: turns it on or off, or replaces its payload.
 * Returns null when the task or step is not there for this member (the route answers 404).
 *
 * - Needs the approve capability of the step's class (403 otherwise; a spend step is for those who
 *   may approve spend), checked before anything about the step's state is revealed.
 * - Only while the task is a draft that has not run out of time and the step is `pending`, and only
 *   from the version the editor saw: otherwise a 409 carrying the step as it is now (`latest`).
 * - The task row is locked first, the order approving also takes, so two edits (or an edit and an
 *   approval) cannot interleave; the UPDATE repeats the version and status checks itself.
 * - A new payload is checked and its preview rebuilt, exactly as when the task was made. Turning a
 *   step on or off leaves the payload and preview alone, so the toggle always works.
 * - Version goes up by one, the editor and time are recorded, and `step.edit` is audited with the
 *   before and after of `{ enabled, payload, version }`.
 */
export async function editStep(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  stepId: string,
  edit: StepEditInput,
  opts: WriteOptions,
): Promise<StepView | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  const step = await getStep(tx, ctx, taskId, stepId);
  if (!step) return null;

  if (!can(ctx, APPROVE[step.approvalClass])) throw new AppError(403, MESSAGES.roleCannot);

  const editable = task.status === 'draft' && !isExpired(task, opts.now) && step.status === 'pending';
  if (!editable || step.version !== edit.version) throw changed(step, ctx);

  let checked: { payload: Record<string, unknown>; preview: Record<string, unknown> } | undefined;
  if (edit.payload !== undefined) {
    if (!isStepType(step.type)) throw new Error(`Step ${step.id} has a type this build does not know.`);
    checked = await checkPayload(tx, ctx, step.type, edit.payload, await companyNameOf(tx, ctx), 'payload');
  }

  const updated = await updatePendingStep(
    tx,
    ctx,
    step.id,
    step.version,
    {
      ...(edit.enabled !== undefined && { enabled: edit.enabled }),
      ...(checked !== undefined && checked),
    },
    opts.now,
  );
  if (!updated) throw changed((await getStep(tx, ctx, taskId, stepId)) ?? step, ctx);

  await audit(tx, ctx, {
    action: 'step.edit',
    targetType: 'agent_task_step',
    targetId: step.id,
    before: { enabled: step.enabled, payload: step.payload, version: step.version },
    after: { enabled: updated.enabled, payload: updated.payload, version: updated.version },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return toStepView(updated, ctx);
}
