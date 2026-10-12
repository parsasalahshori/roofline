import {
  type ActorType,
  type AgentEventKind,
  audit,
  countWorkingTasks,
  customerFirstNames,
  emailCompanyFacts,
  expireOverdueDrafts,
  findRerunOf,
  findStormByPlanTask,
  finishClaimedStep,
  finishParkedStep,
  findStepByIdempotencyKey,
  getCompanyName,
  getStep,
  getTask,
  hasTaskEvent,
  insertAgentEvent,
  insertTask,
  isUniqueViolation,
  listLiveTasksBySubject,
  listSteps,
  listTasks,
  listTasksByStatus,
  loadBaselineOverrides,
  type ListTasksOptions,
  moveStep,
  requeueForRetry,
  setStepResult,
  setStepSnapshot,
  type StepFinish,
  type NewStepRow,
  type StepRow,
  type StepSummaryRow,
  sumStepMinutesSaved,
  type TaskRow,
  type TenantContext,
  type Tx,
  updatePendingStep,
  updateTask,
  type WriteOptions,
} from '@roofline/db';
import {
  type Agent,
  type ApprovalClass,
  isStepType,
  isUserCreatableStepType,
  type PreviewFacts,
  type StepResult,
  type StepStatus,
  type StepType,
  stepMinutes,
  stepTypes,
  type TaskStatus,
} from '@roofline/shared';
import { AppError, MESSAGES } from '../errors.ts';
import { can, type Capability } from '../permissions.ts';

/*
 * The approval queue's rules (spec 4.1): how an agent's task is made, who sees it, how a person
 * edits one of its steps, approves or declines it, retries a step that did not finish, and how a
 * task's status follows its steps as they run. The data access is packages/db's repos/tasks.ts;
 * what a step type needs is packages/shared's registry (steps.ts); running a step is runner.ts.
 *
 * Every writer here, and the runner when it ends a run, locks the task row first
 * (`getTask(..., { forUpdate: true })`) and only then writes its steps, so two writers on one task
 * are taken one after the other and cannot deadlock. The only step writes outside that order hold
 * no other lock: the runner's claim (one step) and the sweeper's lease recovery (steps only). Step
 * rows are only ever changed by plain UPDATEs (FOR NO KEY UPDATE), so a handler's own inserts that
 * reference its step are never blocked.
 */

const NO_CUSTOMERS = "Some of these customers don't exist.";
const ALREADY_HANDLED = 'This was already handled.';
const EXPIRED_PLAN = 'This plan expired before it was approved. You can run it again.';
const RERUN_ONLY_EXPIRED = 'Only expired plans can be run again.';
const RERUN_OFF_REASON = 'This step was switched off.';
export const ALREADY_RERUN = 'This plan was already run again.';
/** The database's own guard on "one copy per plan" (migration 0006). */
export const RERUN_UNIQUE = 'agent_tasks_company_rerun_of_uniq';

/** A step a person still has to say yes or no to. */
const OPEN: readonly StepStatus[] = ['pending', 'awaiting_owner'];
/** A step being worked on. */
const IN_FLIGHT: readonly StepStatus[] = ['queued', 'running'];

/** The capability a person needs to approve (and so to edit or switch off) a step of each class. */
const APPROVE: Record<ApprovalClass, Capability> = {
  message: 'approve_message',
  internal: 'approve_internal',
  spend: 'approve_spend',
};

/** Rounds to 2 decimals, as the snapshot columns do. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Writes the one event for a transition, in the transition's own transaction. `data` holds counts and
 * ids only, never message text or names. The actor's user id is recorded only for a person.
 */
async function event(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  kind: AgentEventKind,
  actorType: ActorType,
  data: Record<string, unknown>,
  at: Date,
  stepId?: string,
  actorUserId?: string,
): Promise<void> {
  await insertAgentEvent(tx, ctx, {
    taskId,
    ...(stepId !== undefined && { stepId }),
    kind,
    actorType,
    ...(actorType === 'user' && { actorUserId: actorUserId ?? ctx.userId }),
    data,
    at,
  });
}

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

/**
 * One step as the review screen gets it. The list leaves the `payload` out (a batch can hold
 * thousands of customer ids); the views of one task, and of one step after an edit, carry it so the
 * editor can fill itself in.
 */
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
  /** How many times the runner has started this step (0 until it runs; back to 0 on a retry). */
  attempts: number;
  /** What the step reported when it ran (counts only, never payload data), or null before it has. */
  result: StepResult | null;
  /** Why the step failed or needs attention, in words a person can read, or null. */
  errorPlain: string | null;
  /** What the step does, as saved. Only on the views of one task and of an edited step, never on the list. */
  payload?: Record<string, unknown>;
};

/** Which views carry each step's payload. The list does not; opening one task, editing a step, and a 409's `latest` do. */
export type StepViewOptions = { payload?: boolean };

/** A step row as the views take it: the payload is there only when it was read (`listSteps(..., { payload: true })`, `getStep`). */
type StepViewRow = StepSummaryRow & { payload?: Record<string, unknown> };

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
  /** Minutes of staff time the plan saved, set when it finishes; null until then. */
  minutesSaved: number | null;
  /** The expired plan this one was made from by "run again", or null for an ordinary plan. */
  rerunOfTaskId: string | null;
  steps: StepView[];
};

export function toStepView(row: StepViewRow, ctx: TenantContext, options: StepViewOptions = {}): StepView {
  if (options.payload === true && row.payload === undefined) {
    throw new Error(`Step ${row.id} was read without its payload but its view asks for it.`);
  }
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
    attempts: row.attempts,
    // A handler's result is a StepResult (runner.ts saves only what a handler returned).
    result: (row.result ?? null) as StepResult | null,
    errorPlain: row.errorPlain,
    ...(options.payload === true && { payload: row.payload }),
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

export function toTaskView(
  task: TaskRow,
  steps: readonly StepViewRow[],
  ctx: TenantContext,
  now: Date,
  options: StepViewOptions = {},
): TaskView {
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
    minutesSaved: task.minutesSaved,
    rerunOfTaskId: task.rerunOfTaskId,
    steps: steps.map((step) => toStepView(step, ctx, options)),
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
  if (type !== 'send_sms_batch' && type !== 'send_email_batch') return { companyName };
  const { customerIds } = payload as { customerIds: string[] };
  const firstNames = await customerFirstNames(tx, ctx, customerIds);
  if (customerIds.some((id) => !firstNames.has(id))) throw new AppError(400, NO_CUSTOMERS, `${field}.customerIds`);
  const facts: PreviewFacts = {
    companyName,
    recipientCount: customerIds.length,
    // The first customer listed, whatever order the database would give them back in.
    sampleFirstName: firstNames.get(customerIds[0]!) ?? '',
  };
  if (type === 'send_email_batch') {
    const address = (await emailCompanyFacts(tx, ctx))?.address ?? null;
    if (address !== null) facts.companyAddress = address;
  }
  return facts;
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

/** The short title a switched-off step shows when its payload is too incomplete to build a preview. */
const OFF_STEP_TITLES: Record<StepType, string> = {
  demo_noop: 'Demo step',
  demo_message: 'Demo message',
  demo_spend: 'Demo spend',
  send_sms_batch: 'Text your customers',
  front_desk_call: 'Answer a call',
  front_desk_texts: 'Answer texts',
  send_email_batch: 'Email your customers',
  build_routes: 'Plan door-knocking routes',
  create_ad_campaign: 'Run an ad campaign',
  send_proposal: 'Send a proposal',
  order_exact_report: 'Order a roof report',
  // G1 (Ruling BC)
  send_personal_texts: 'Send personal texts',
  build_claim_packet: 'Build the claim packet',
  create_appointment: 'Book an appointment',
  move_appointment: 'Move an appointment',
};

export type NewTask = {
  agent: Agent;
  kind: string;
  title: string;
  summary?: string;
  subjectType?: string;
  subjectId?: string;
  expiresAt?: Date;
  mode?: 'needs_approval' | 'live';
  /** Only `rerunTask` sets this: the expired plan the new one is a fresh copy of. */
  rerunOfTaskId?: string;
  /** Who made the plan, for its `created` event. Default `agent`. */
  createdBy?: 'agent' | 'system' | 'user';
  /** Acting member for a `user` created event when ctx.userId is null (system context). */
  createdByUserId?: string;
  /** `off`: the step is saved switched off (enabled=false) with this plain reason; its payload may then be incomplete (for example no customers). */
  steps: { type: StepType; payload: unknown; off?: string }[];
};

/**
 * Makes a draft task with its steps, for an agent. This is the service the agents and the demo seed
 * call; no HTTP route creates tasks (`rerunTask` copies an expired one, through this function).
 * Built-in step types a person cannot create (front_desk_*) are refused unless the caller passes
 * `allowInternalStepTypes`, which only `rerunTask` does.
 * - Each step's payload is checked by its step type, so a bad one is a 400 on `steps.N.payload`
 *   (a text to customers that do not exist is one on `steps.N.payload.customerIds`) and nothing is saved.
 * - The approval class comes from the step type, never from the agent.
 * - Steps start `pending`, enabled, at version 1, with a new idempotency key each; the task is a `draft`.
 * - The preview each step shows is built here, from the checked payload.
 * - A step with `off` is saved switched off with that plain reason, and an incomplete payload is kept as given instead of a 400.
 * Runs in the caller's `withTenant` transaction.
 */
export async function createTask(
  tx: Tx,
  ctx: TenantContext,
  input: NewTask,
  opts: WriteOptions & { allowInternalStepTypes?: boolean },
): Promise<{ taskId: string }> {
  if (input.steps.length === 0) throw new AppError(400, 'A plan needs at least one step.', 'steps');

  const companyName = await companyNameOf(tx, ctx);
  const steps: NewStepRow[] = [];
  for (const [n, step] of input.steps.entries()) {
    // Only `rerunTask` passes allowInternalStepTypes: built-in steps (front_desk_*) are copied over
    // from an expired plan. Every other caller, the API routes included, is refused them.
    const allowed = opts.allowInternalStepTypes ? isStepType(step.type) : isUserCreatableStepType(step.type);
    if (!allowed) throw new AppError(400, "That kind of step isn't supported.", `steps.${n}.type`);
    let checked: { payload: Record<string, unknown>; preview: Record<string, unknown> };
    if (step.off === undefined) {
      checked = await checkPayload(tx, ctx, step.type, step.payload, companyName, `steps.${n}.payload`);
    } else {
      try {
        checked = await checkPayload(tx, ctx, step.type, step.payload, companyName, `steps.${n}.payload`);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        const raw = step.payload;
        const payload = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        checked = { payload, preview: { title: OFF_STEP_TITLES[step.type], lines: [] } };
      }
      checked = { payload: checked.payload, preview: { ...checked.preview, offReason: step.off } };
    }
    steps.push({
      type: step.type,
      approvalClass: stepTypes[step.type].approvalClass,
      ...checked,
      ...(step.off !== undefined && { enabled: false, errorPlain: step.off }),
    });
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
      rerunOfTaskId: input.rerunOfTaskId ?? null,
      steps,
    },
    opts.now,
  );
  await event(tx, ctx, taskId, 'created', input.createdBy ?? 'agent', { stepCount: steps.length }, opts.now, undefined, input.createdByUserId);
  await audit(tx, input.createdByUserId !== undefined ? { ...ctx, userId: input.createdByUserId } : ctx, {
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

/** List views of these tasks, in the order given, each with its steps (no payloads). */
async function listViews(tx: Tx, ctx: TenantContext, tasks: readonly TaskRow[], now: Date): Promise<TaskView[]> {
  const steps = await listSteps(
    tx,
    ctx,
    tasks.map((task) => task.id),
  );
  // listSteps gives each task's steps in position order; keep that order within the group.
  const byTask = new Map<string, StepSummaryRow[]>();
  for (const step of steps) byTask.set(step.taskId, [...(byTask.get(step.taskId) ?? []), step]);
  return tasks.map((task) => toTaskView(task, byTask.get(task.id) ?? [], ctx, now));
}

/**
 * The tasks waiting on this member, newest first, as `{ count, tasks }` (`count` is what the "N need
 * your OK" pill shows). The owner, and office staff the owner has let approve spend, see drafts and
 * the plans waiting on the owner; other office staff see drafts only; a rep sees nothing.
 * A draft past its time is still listed, marked `expired`, until the expiry job moves it, but it is
 * not counted: the pill only nags about plans that can still be approved.
 */
export async function listApprovals(tx: Tx, ctx: TenantContext, now: Date): Promise<{ count: number; tasks: TaskView[] }> {
  if (!canReview(ctx)) return { count: 0, tasks: [] };
  const statuses: TaskStatus[] = can(ctx, 'approve_spend') ? ['draft', 'awaiting_owner'] : ['draft'];
  const views = await listViews(tx, ctx, await listTasksByStatus(tx, ctx, statuses), now);
  return { count: views.filter((view) => !view.expired).length, tasks: views };
}

/**
 * One task in any status (the screen shows how a plan ended, too), or null for a rep, an unknown id
 * or another company's. Unlike the list, each step carries its payload, for the editor.
 */
export async function getApproval(tx: Tx, ctx: TenantContext, taskId: string, now: Date): Promise<TaskView | null> {
  if (!canReview(ctx)) return null;
  const task = await getTask(tx, ctx, taskId);
  if (!task) return null;
  return toTaskView(task, await listSteps(tx, ctx, [task.id], { payload: true }), ctx, now, { payload: true });
}

// ---------------------------------------------------------------------------------------------
// Editing a step

export type StepEditInput = {
  /** The version the editor was looking at. */
  version: number;
  enabled?: boolean;
  payload?: Record<string, unknown>;
};

/** The screen was showing something that is out of date: 409 with the step as it is now (payload included, so the editor can refresh from it). */
function changed(step: StepRow, ctx: TenantContext): AppError {
  return new AppError(409, MESSAGES.changedWhileLooking, undefined, toStepView(step, ctx, { payload: true }));
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
 * - Returns the step as saved, payload included (the editor refills from it).
 */
/** The kind of task the Storm Scout plan builder makes (storm/plan.ts). */
const STORM_PLAN_KIND = 'storm_plan';

const STORM_MESSAGES = {
  stayMarketing: "Storm texts and emails stay marketing messages, so that can't be changed.",
  keyLocked: "The message key for a storm plan can't be changed.",
  stormLocked: "The storm for a storm plan email can't be changed.",
  adCeiling: "You can lower the ad budget or days, but not raise them above what was drafted.",
} as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/**
 * Edits to a storm plan step keep the rules the plan was drafted under: texts and emails stay
 * marketing, their dedupe key and storm stay put, and an ad can be lowered but not raised.
 * Compares the stored payload with the already-checked new one; other task kinds are not touched.
 */
function keepStormRules(type: string, stored: Record<string, unknown>, next: Record<string, unknown>): void {
  if (type === 'send_sms_batch' || type === 'send_email_batch') {
    if (next.purpose !== 'marketing') throw new AppError(400, STORM_MESSAGES.stayMarketing, 'payload.purpose');
    if (next.dedupePrefix !== stored.dedupePrefix) throw new AppError(400, STORM_MESSAGES.keyLocked, 'payload.dedupePrefix');
    if (type === 'send_email_batch' && next.companyStormId !== stored.companyStormId) {
      throw new AppError(400, STORM_MESSAGES.stormLocked, 'payload.companyStormId');
    }
  } else if (type === 'create_ad_campaign') {
    for (const field of ['maxSpendCents', 'days'] as const) {
      const was = stored[field];
      const now = next[field];
      if (typeof was === 'number' && typeof now === 'number' && now > was) {
        throw new AppError(400, STORM_MESSAGES.adCeiling, `payload.${field}`);
      }
    }
  }
}

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
    if (task.kind === STORM_PLAN_KIND) keepStormRules(step.type, asRecord(step.payload), checked.payload);
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
  return toStepView(updated, ctx, { payload: true });
}

// ---------------------------------------------------------------------------------------------
// Approving

/** The detail view of a task as it is now: every step, with its payload. */
async function currentView(tx: Tx, ctx: TenantContext, taskId: string, now: Date): Promise<TaskView> {
  const task = await getTask(tx, ctx, taskId);
  if (!task) throw new Error(`Task ${taskId} disappeared inside its own transaction.`);
  return toTaskView(task, await listSteps(tx, ctx, [taskId], { payload: true }), ctx, now, { payload: true });
}

/** What the approval screen sends for each step it showed. */
export type SeenStep = { id: string; version: number };

/** What happens to one step that waits for a yes. */
type Decision = { step: StepRow; to: 'skipped' | 'queued' | 'awaiting_owner' };

/**
 * Approves a draft (or the part of a plan that waits on the owner) for the caller. Returns the step
 * ids to hand to the queue and the task's detail view, or null when the task is not there for this
 * member (the route answers 404). Runs in the caller's transaction; the route enqueues the ids only
 * after it commits.
 *
 * - The task row is locked first. A plan whose time ran out is a 409 ("This plan expired before it
 *   was approved. You can run it again."); one that is not a draft or waiting on the owner is a 409
 *   "This was already handled.".
 * - Every step still waiting for a yes (`pending` or `awaiting_owner`) must be in `seen` at the
 *   version it has now; otherwise the screen is out of date: 409 carrying the task as it is now.
 * - Then each such step: switched off → `skipped`; the caller may approve its class → `queued`,
 *   with who approved it and when; otherwise → `awaiting_owner` (partial approval, never a 403).
 *   When that changes nothing (an office user approving a plan that only waits on the owner), it is
 *   the "already handled" 409, so a second click never writes anything.
 * - Each step about to run is checked again exactly as when it was made (the company may have been
 *   renamed since): a failure is a 400 on `steps.<stepId>.payload` and nothing is approved.
 * - The task becomes `awaiting_owner` if any step waits on the owner, else `running` when something
 *   was queued, else `done` (everything was switched off). It records the first approval's person
 *   and time. `task.approve` is audited with the step ids that were approved, left for the owner
 *   and skipped.
 */
export async function approveTask(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  seen: readonly SeenStep[],
  opts: WriteOptions,
): Promise<{ toEnqueue: string[]; task: TaskView } | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  if (isExpired(task, opts.now)) throw new AppError(409, EXPIRED_PLAN);
  if (task.status !== 'draft' && task.status !== 'awaiting_owner') throw new AppError(409, ALREADY_HANDLED);

  const steps = await listSteps(tx, ctx, [taskId], { payload: true });
  const open = steps.filter((step) => OPEN.includes(step.status));
  const shown = new Map(seen.map((s) => [s.id, s.version]));
  if (open.some((step) => shown.get(step.id) !== step.version)) {
    throw new AppError(409, MESSAGES.changedWhileLooking, undefined, toTaskView(task, steps, ctx, opts.now, { payload: true }));
  }

  const decisions: Decision[] = open.map((step) => ({
    step,
    to: !step.enabled ? 'skipped' : can(ctx, APPROVE[step.approvalClass]) ? 'queued' : 'awaiting_owner',
  }));
  if (decisions.every(({ step, to }) => step.status === to)) throw new AppError(409, ALREADY_HANDLED);

  const toRun = decisions.filter(({ to }) => to === 'queued').map(({ step }) => step);
  if (toRun.length > 0) {
    const companyName = await companyNameOf(tx, ctx);
    for (const step of toRun) {
      if (!isStepType(step.type)) throw new Error(`Step ${step.id} has a type this build does not know.`);
      await checkPayload(tx, ctx, step.type, step.payload, companyName, `steps.${step.id}.payload`);
    }
  }

  for (const { step, to } of decisions) {
    if (step.status === to) continue;
    const move = to === 'queued' ? { status: to, approvedByUserId: ctx.userId, approvedAt: opts.now } : { status: to };
    // Cannot miss: every writer of a waiting step holds this task's lock, which this transaction has.
    if (!(await moveStep(tx, ctx, step.id, OPEN, move, opts.now))) throw new Error(`Step ${step.id} moved while its task was locked.`);
  }

  const toEnqueue = toRun.map((step) => step.id);
  const awaitingOwner = decisions.filter(({ to }) => to === 'awaiting_owner').map(({ step }) => step.id);
  const status: TaskStatus = awaitingOwner.length > 0 ? 'awaiting_owner' : toEnqueue.length > 0 ? 'running' : 'done';
  const firstApproval = toEnqueue.length > 0 && task.approvedAt === null;
  await updateTask(
    tx,
    ctx,
    taskId,
    { status: status === 'done' ? 'running' : status, ...(firstApproval && { approvedByUserId: ctx.userId, approvedAt: opts.now }) },
    opts.now,
  );
  await event(
    tx,
    ctx,
    taskId,
    awaitingOwner.length > 0 ? 'partly_approved' : 'approved',
    'user',
    { approvedSteps: toEnqueue.length, totalSteps: steps.length, forwardedSteps: awaitingOwner.length },
    opts.now,
  );
  // A plan with nothing left to run was written as `running` above, so refreshTask moves it to `done`,
  // records its minutes and writes the one `finished` event. It is the only writer of that event.
  await refreshTask(tx, ctx, taskId, opts.now);

  await audit(tx, ctx, {
    action: 'task.approve',
    targetType: 'agent_task',
    targetId: taskId,
    after: {
      approvedStepIds: toEnqueue,
      awaitingOwnerStepIds: awaitingOwner,
      skippedStepIds: decisions.filter(({ to }) => to === 'skipped').map(({ step }) => step.id),
    },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return { toEnqueue, task: await currentView(tx, ctx, taskId, opts.now) };
}

// ---------------------------------------------------------------------------------------------
// Declining

/**
 * Declines a plan that is still waiting for a yes (a draft, or one waiting on the owner; otherwise
 * 409 "This was already handled."). Every step still waiting is `skipped`; a step that was already
 * approved and queued keeps going. The task is `declined` with who, when and the reason (null when
 * none was given), and `task.decline` is audited. Returns the detail view, or null when the task is
 * not there for this member.
 */
export async function declineTask(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  reason: string | null,
  opts: WriteOptions,
): Promise<TaskView | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  if (task.status !== 'draft' && task.status !== 'awaiting_owner') throw new AppError(409, ALREADY_HANDLED);

  const skipped: string[] = [];
  for (const step of await listSteps(tx, ctx, [taskId])) {
    if (!OPEN.includes(step.status)) continue;
    if (!(await moveStep(tx, ctx, step.id, OPEN, { status: 'skipped' }, opts.now))) {
      throw new Error(`Step ${step.id} moved while its task was locked.`);
    }
    skipped.push(step.id);
  }
  await updateTask(
    tx,
    ctx,
    taskId,
    { status: 'declined', declinedByUserId: ctx.userId, declinedAt: opts.now, declineReason: reason },
    opts.now,
  );
  await event(tx, ctx, taskId, 'declined', 'user', { skippedSteps: skipped.length }, opts.now);
  // What was approved before the decline may have finished already: its minutes still count.
  await refreshTask(tx, ctx, taskId, opts.now);

  await audit(tx, ctx, {
    action: 'task.decline',
    targetType: 'agent_task',
    targetId: taskId,
    before: { status: task.status },
    after: { status: 'declined', reason, skippedStepIds: skipped },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return currentView(tx, ctx, taskId, opts.now);
}

/**
 * Ruling AX-H: a newer storm plan supersedes an old draft. Locks the old task first, skips its open
 * steps and declines it as the system, with one `declined` event that names the replacement. Returns
 * true when it superseded, false when the task is gone or no longer a draft. No audit row.
 */
export async function supersedeDraft(tx: Tx, ctx: TenantContext, oldTaskId: string, newTaskId: string, now: Date): Promise<boolean> {
  const task = await getTask(tx, ctx, oldTaskId, { forUpdate: true });
  if (!task || task.status !== 'draft') return false;

  let skipped = 0;
  for (const step of await listSteps(tx, ctx, [oldTaskId])) {
    if (!OPEN.includes(step.status)) continue;
    if (!(await moveStep(tx, ctx, step.id, OPEN, { status: 'skipped' }, now))) {
      throw new Error(`Step ${step.id} moved while its task was locked.`);
    }
    skipped += 1;
  }
  await updateTask(
    tx,
    ctx,
    oldTaskId,
    { status: 'declined', declinedByUserId: null, declinedAt: now, declineReason: 'Replaced by a newer plan.' },
    now,
  );
  await event(tx, ctx, oldTaskId, 'declined', 'system', { skippedSteps: skipped, replacedByTaskId: newTaskId }, now);
  return true;
}

/**
 * Declines one step that waits on the owner, leaving the rest of the plan as it is. Needs the
 * spend approval (403 otherwise); a step that is not `awaiting_owner` is a 409 "This was already
 * handled.". The step is `skipped`, the task's status follows (`refreshTask`), and `step.decline` is
 * audited. Returns the task's detail view, or null when the task or step is not there for this member.
 */
export async function declineStep(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  stepId: string,
  opts: WriteOptions,
): Promise<TaskView | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  const step = await getStep(tx, ctx, taskId, stepId);
  if (!step) return null;
  if (!can(ctx, 'approve_spend')) throw new AppError(403, MESSAGES.roleCannot);
  if (step.status !== 'awaiting_owner') throw new AppError(409, ALREADY_HANDLED);

  if (!(await moveStep(tx, ctx, step.id, ['awaiting_owner'], { status: 'skipped' }, opts.now))) {
    throw new Error(`Step ${step.id} moved while its task was locked.`);
  }
  await event(tx, ctx, taskId, 'declined', 'user', { skippedSteps: 1 }, opts.now, step.id);
  await refreshTask(tx, ctx, taskId, opts.now);
  await audit(tx, ctx, {
    action: 'step.decline',
    targetType: 'agent_task_step',
    targetId: step.id,
    before: { status: step.status },
    after: { status: 'skipped' },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return currentView(tx, ctx, taskId, opts.now);
}

// ---------------------------------------------------------------------------------------------
// Retrying

/**
 * Puts a step that did not finish back in the queue: one that `failed` or `needs_attention`, or one
 * still `running` past its lease (its run died before the sweeper got to it). Needs the approve
 * capability of the step's class (403 otherwise). A declined plan, or a step in any other state, is
 * a 409 "This was already handled.". The step goes back to `queued` with its attempts at 0, its error
 * and lease cleared, and keeps its idempotency key, so whatever it already did is not done twice.
 * The task is `running` again (or stays `awaiting_owner` while another step waits on the owner),
 * and `step.retry` is audited. Returns the id to hand to the queue after the commit and the task's
 * detail view, or null when the task or step is not there for this member.
 */
export async function retryStep(
  tx: Tx,
  ctx: TenantContext,
  taskId: string,
  stepId: string,
  opts: WriteOptions,
): Promise<{ toEnqueue: string[]; task: TaskView } | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  const step = await getStep(tx, ctx, taskId, stepId);
  if (!step) return null;
  if (!can(ctx, APPROVE[step.approvalClass])) throw new AppError(403, MESSAGES.roleCannot);
  // The owner's "no" stands: nothing of a declined plan is run again.
  if (task.status === 'declined') throw new AppError(409, ALREADY_HANDLED);
  const stalled = step.status === 'running' && step.leaseExpiresAt !== null && step.leaseExpiresAt < opts.now;
  if (step.status !== 'failed' && step.status !== 'needs_attention' && !stalled) throw new AppError(409, ALREADY_HANDLED);

  // The sweeper can put a stalled step back without the task lock, so this can lose that race.
  const moved = await requeueForRetry(tx, ctx, step.id, opts.now);
  if (!moved) throw new AppError(409, ALREADY_HANDLED);

  const waitsOnOwner = (await listSteps(tx, ctx, [taskId])).some((s) => s.status === 'awaiting_owner');
  const status: TaskStatus = waitsOnOwner ? 'awaiting_owner' : 'running';
  if (task.status !== status) await updateTask(tx, ctx, taskId, { status }, opts.now);

  await audit(tx, ctx, {
    action: 'step.retry',
    targetType: 'agent_task_step',
    targetId: step.id,
    before: { status: step.status, attempts: step.attempts, errorPlain: step.errorPlain },
    after: { status: 'queued', attempts: 0 },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return { toEnqueue: [step.id], task: await currentView(tx, ctx, taskId, opts.now) };
}

// ---------------------------------------------------------------------------------------------
// Running an expired plan again

/**
 * "Expired — run again?": makes a fresh draft from a plan whose time ran out, and returns its
 * detail view (payloads included). Null when the task is not there for this member (a rep, an
 * unknown id, another company's: the route answers 404).
 *
 * - Only an expired plan: marked `expired`, or a draft past `expiresAt` that the expiry job has not
 *   reached yet (`isExpired`; that draft is marked `expired` now, as the job would). Anything else
 *   is a 409 "Only expired plans can be run again.".
 * - Only once: the new draft records the plan it came from (`rerun_of_task_id`), and a plan that
 *   already has a copy is a 409 "This plan was already run again." (a double-click, or two people at
 *   once). The old plan's row is locked FOR UPDATE before that check, so two reruns are taken one
 *   after the other and the second sees the first's copy; the unique index on
 *   `(company_id, rerun_of_task_id)` backs that up, and its violation is the same 409.
 * - The new draft is made with `createTask`, exactly as an agent makes one: the same agent, kind,
 *   title, summary, subject and mode, and the same steps in the same order (type and payload; each
 *   step keeps its on/off state, pending, at version 1, with new ids and new idempotency keys; a
 *   switched-off step keeps its reason and its payload as given). Each payload is checked
 *   again, so a step that no longer passes (a text naming the company's old name) is a 400 on
 *   `steps.N.payload` and nothing is made.
 * - Its window is as long as the old one's: `expires_at = now + (old expires_at - old created_at)`,
 *   or none when the old plan had none.
 * - The old plan is left as it was (expired, its steps pending). `task.rerun` is audited on the new
 *   task with `{ fromTaskId }`, after `createTask`'s own `task.create`.
 */
export async function rerunTask(tx: Tx, ctx: TenantContext, taskId: string, opts: WriteOptions): Promise<TaskView | null> {
  if (!canReview(ctx)) return null;
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  if (!isExpired(task, opts.now)) throw new AppError(409, RERUN_ONLY_EXPIRED);
  if ((await findRerunOf(tx, ctx, taskId)) !== null) throw new AppError(409, ALREADY_RERUN);
  if (task.status === 'draft') {
    await updateTask(tx, ctx, taskId, { status: 'expired' }, opts.now);
    await event(tx, ctx, taskId, 'expired', 'system', {}, opts.now);
  }

  const window = task.expiresAt === null ? null : task.expiresAt.getTime() - task.createdAt.getTime();
  const steps = await listSteps(tx, ctx, [taskId], { payload: true });
  let freshId: string;
  try {
    ({ taskId: freshId } = await createTask(
      tx,
      ctx,
      {
        agent: task.agent,
        kind: task.kind,
        title: task.title,
        ...(task.summary !== null && { summary: task.summary }),
        ...(task.subjectType !== null && { subjectType: task.subjectType }),
        ...(task.subjectId !== null && { subjectId: task.subjectId }),
        mode: task.mode,
        ...(window !== null && { expiresAt: new Date(opts.now.getTime() + window) }),
        rerunOfTaskId: taskId,
        createdBy: 'user',
        // Rerun passes allowInternalStepTypes so built-in steps (front_desk_*) copy over; a type this
        // build does not know is still a 400 on steps.N.type.
        steps: steps.map((step) => ({
          type: step.type as StepType,
          payload: step.payload,
          ...(step.enabled ? {} : { off: step.errorPlain ?? RERUN_OFF_REASON }),
        })),
      },
      { ...opts, allowInternalStepTypes: true },
    ));
  } catch (err) {
    // A copy that slipped past the check above (made by a path that did not take the lock).
    if (isUniqueViolation(err, RERUN_UNIQUE)) throw new AppError(409, ALREADY_RERUN);
    throw err;
  }

  await audit(tx, ctx, {
    action: 'task.rerun',
    targetType: 'agent_task',
    targetId: freshId,
    after: { fromTaskId: taskId },
    ip: opts.ip ?? null,
    at: opts.now,
  });
  return currentView(tx, ctx, freshId, opts.now);
}

// ---------------------------------------------------------------------------------------------
// Following the steps

/** Minutes of staff time the task's finished steps saved: the sum of their snapshots, rounded. */
async function minutesSavedOf(tx: Tx, ctx: TenantContext, taskId: string): Promise<number> {
  return Math.round(await sumStepMinutesSaved(tx, ctx, taskId));
}

/**
 * Records how a step's run ended, in the transaction that saved it: a done step gets its time-saved
 * snapshot (units from its result, minutes per unit from the company's baselines as they are now)
 * and every outcome its one event. A step still queued or running writes nothing; a failed or
 * attention step gets no snapshot and so counts zero.
 */
async function recordOutcome(tx: Tx, ctx: TenantContext, row: StepRow, now: Date): Promise<void> {
  if (row.status === 'done') {
    if (!isStepType(row.type)) return;
    const overrides = await loadBaselineOverrides(tx, ctx);
    const m = stepMinutes(stepTypes[row.type] as never, row.payload as never, (row.result ?? {}) as StepResult, overrides);
    await setStepSnapshot(
      tx,
      ctx,
      row.id,
      { baselineKey: m.baseline, units: m.units, minutesPerUnit: m.minutesPerUnit, minutesSaved: m.minutes },
      now,
    );
    await event(tx, ctx, row.taskId, 'step_done', 'agent', { units: round2(m.units), minutes: round2(m.minutes) }, now, row.id);
  } else if (row.status === 'failed') {
    await event(tx, ctx, row.taskId, 'step_failed', 'agent', { attempts: row.attempts }, now, row.id);
  } else if (row.status === 'needs_attention') {
    await event(tx, ctx, row.taskId, 'step_attention', 'agent', { attempts: row.attempts }, now, row.id);
  }
}

/**
 * The runner's end of a run: saves how it ended (only if the run still holds the step's lease) and
 * its snapshot and event in the same transaction. A stale run returns null and writes nothing.
 */
export async function completeClaimedStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  runSeq: number,
  finish: StepFinish,
  now: Date,
): Promise<StepRow | null> {
  const saved = await finishClaimedStep(tx, ctx, stepId, runSeq, finish, now);
  if (!saved) return null;
  await recordOutcome(tx, ctx, saved, now);
  return saved;
}

/** The dispatcher's end of a parked step: the same as `completeClaimedStep`, for a step finished by its texts. */
export async function completeParkedStep(
  tx: Tx,
  ctx: TenantContext,
  stepId: string,
  finish: Parameters<typeof finishParkedStep>[3],
  now: Date,
): Promise<StepRow | null> {
  const saved = await finishParkedStep(tx, ctx, stepId, finish, now);
  if (!saved) return null;
  await recordOutcome(tx, ctx, saved, now);
  return saved;
}

/** The expiry job's write: drafts past their time become `expired`, each with its one event. Returns their ids. */
export async function expireOverdueTasks(tx: Tx, ctx: TenantContext, now: Date): Promise<string[]> {
  const ids = await expireOverdueDrafts(tx, ctx, now);
  for (const id of ids) await event(tx, ctx, id, 'expired', 'system', {}, now);
  return ids;
}

/**
 * Brings a task's status in line with its steps after one of them changed (it ran, was declined or
 * was retried). Locks the task row (a no-op when the caller already holds it). Returns the task as
 * it is now, or null when it is not there.
 *
 * - While any step is still queued, running or waiting on the owner, the task is not finished: it
 *   is `awaiting_owner` if a step waits on the owner, else `running`.
 * - Once none is, the task is finished: `needs_attention` if any step needs attention, else
 *   `partly_done` if any failed, else `done` (every step that was not skipped is done). Its
 *   `minutes_saved` is then set from the done steps.
 * - A draft or an expired plan is left alone (nothing of it was approved). A declined plan keeps
 *   its status, so the owner's "no" stands, but the steps approved before it still count their minutes.
 */
export async function refreshTask(tx: Tx, ctx: TenantContext, taskId: string, now: Date): Promise<TaskRow | null> {
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task || task.status === 'draft' || task.status === 'expired') return task;

  const steps = await listSteps(tx, ctx, [taskId]);
  const any = (statuses: readonly StepStatus[]) => steps.some((step) => statuses.includes(step.status));
  const declined = task.status === 'declined';

  if (any(['awaiting_owner', ...IN_FLIGHT])) {
    const status: TaskStatus = any(['awaiting_owner']) ? 'awaiting_owner' : 'running';
    if (declined || status === task.status) return task;
    return updateTask(tx, ctx, taskId, { status }, now);
  }
  // A step nobody has said yes or no to cannot sit in an approved plan; never finish one that has it.
  if (any(['pending'])) return task;

  const status: TaskStatus = any(['needs_attention']) ? 'needs_attention' : any(['failed']) ? 'partly_done' : 'done';
  const minutesSaved = await minutesSavedOf(tx, ctx, taskId);
  const updated = await updateTask(tx, ctx, taskId, { ...(!declined && { status }), minutesSaved }, now);
  // One `finished` event per real move into a final status; a declined plan's status does not move.
  // Only a final status is finished: needs_attention is not, and a status already written is not written twice.
  const final = status !== 'needs_attention';
  if (!declined && final && task.status !== status && !(await hasTaskEvent(tx, ctx, taskId, 'finished'))) {
    await event(tx, ctx, taskId, 'finished', 'system', { status, minutesSaved }, now);
  }
  return updated;
}

// ---------------------------------------------------------------------------------------------
// The activity feed

export type TaskFeedQuery = Pick<ListTasksOptions, 'agent' | 'status' | 'since' | 'limit'>;

/**
 * The company's tasks in any status, newest first, narrowed by agent, status and creation time,
 * as list views (no payloads). For the owner and the office; a rep gets an empty list.
 */
export async function listTaskFeed(tx: Tx, ctx: TenantContext, query: TaskFeedQuery, now: Date): Promise<TaskView[]> {
  if (!canReview(ctx)) return [];
  return listViews(tx, ctx, await listTasks(tx, ctx, query), now);
}

/**
 * The "N agents working" number: how many tasks have a step queued or running (a plan waiting for
 * a yes is not working). For the owner and the office; a rep always gets 0.
 */
export async function workingCount(tx: Tx, ctx: TenantContext): Promise<number> {
  return canReview(ctx) ? countWorkingTasks(tx, ctx) : 0;
}

// ---------------------------------------------------------------------------------------------
// Live tasks (A1 Task 4).

export type NewLiveTask = {
  agent: Agent;
  kind: string;
  title: string;
  subjectType?: string;
  subjectId?: string;
  step: { type: 'front_desk_call' | 'front_desk_texts'; result: Record<string, number> };
  /** `done`, or `needs_attention` while a follow-up is open. */
  status: 'done' | 'needs_attention';
  /** Unique per finished call / per text conversation per day. A repeat call returns the existing task. */
  idempotencyKey: string;
};

/** Creates one live task with its one already-finished step. Idempotent on `idempotencyKey`. */
export async function createLiveTask(
  tx: Tx,
  ctx: TenantContext,
  input: NewLiveTask,
  now: Date,
): Promise<{ taskId: string; created: boolean }> {
  const existing = await findStepByIdempotencyKey(tx, ctx, input.idempotencyKey);
  if (existing) return { taskId: existing.taskId, created: false };

  let taskId: string;
  try {
    // A savepoint, so losing a race on the unique key does not abort the caller's transaction.
    taskId = await tx.transaction(async (sp) => {
      const inserted = await insertTask(
        sp,
        ctx,
        {
          agent: input.agent,
          kind: input.kind,
          title: input.title,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          mode: 'live',
          status: input.status,
          steps: [
            {
              type: input.step.type,
              approvalClass: stepTypes[input.step.type].approvalClass,
              payload: { label: input.title },
              preview: { title: input.title, lines: [] },
              status: 'done',
              result: input.step.result,
              idempotencyKey: input.idempotencyKey,
            },
          ],
        },
        now,
      );
      return inserted.taskId;
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await findStepByIdempotencyKey(tx, ctx, input.idempotencyKey);
    if (!raced) throw error;
    return { taskId: raced.taskId, created: false };
  }

  await event(tx, ctx, taskId, 'created', 'agent', { stepCount: 1 }, now);
  const [step] = await listSteps(tx, ctx, [taskId], { payload: true });
  // One millisecond apart, so the events read back in the order they happened (the list sorts by time, then id).
  const stepAt = new Date(now.getTime() + 1);
  const endAt = new Date(now.getTime() + 2);
  await recordOutcome(tx, ctx, step!, stepAt);
  const minutesSaved = await minutesSavedOf(tx, ctx, taskId);
  await updateTask(tx, ctx, taskId, { minutesSaved }, now);
  if (input.status === 'done') {
    await event(tx, ctx, taskId, 'finished', 'system', { status: 'done', minutesSaved }, endAt);
  } else {
    await event(tx, ctx, taskId, 'step_attention', 'agent', { attempts: 0 }, endAt, step!.id);
  }
  await audit(tx, ctx, {
    action: 'task.create',
    targetType: 'agent_task',
    targetId: taskId,
    after: { agent: input.agent, kind: input.kind, title: input.title, steps: [input.step.type] },
    ip: null,
    at: now,
  });
  return { taskId, created: true };
}

/** Closes each live `needs_attention` task about this job to `done` (one `finished` event each). Returns the count closed. */
export async function closeLiveTasksForSubject(
  tx: Tx,
  ctx: TenantContext,
  subjectType: string,
  subjectId: string,
  now: Date,
): Promise<number> {
  const rows = await listLiveTasksBySubject(tx, ctx, { agent: 'front_desk', subjectType, subjectId, status: 'needs_attention' });
  for (const row of rows) {
    const minutesSaved = await minutesSavedOf(tx, ctx, row.id);
    await updateTask(tx, ctx, row.id, { status: 'done', minutesSaved }, now);
    if (!(await hasTaskEvent(tx, ctx, row.id, 'finished'))) {
      await event(tx, ctx, row.id, 'finished', 'system', { status: 'done', minutesSaved }, now);
    }
  }
  return rows.length;
}

/** Adds counts to a finished live task's step result (a repeat on the same key), then refreshes its minutes. Writes no events. */
export async function addToLiveTask(
  tx: Tx,
  ctx: TenantContext,
  idempotencyKey: string,
  add: Record<string, number>,
  now: Date,
): Promise<string | null> {
  const found = await findStepByIdempotencyKey(tx, ctx, idempotencyKey);
  if (!found) return null;
  // The step row is locked, so two repeats on one key add up instead of overwriting each other.
  const row = await getStep(tx, ctx, found.taskId, found.id, { forUpdate: true });
  if (!row || row.status !== 'done' || !isStepType(row.type)) return found.taskId;
  const prev = (row.result ?? {}) as Record<string, number>;
  const next: Record<string, number> = { ...prev };
  for (const [k, v] of Object.entries(add)) next[k] = (Number(prev[k]) || 0) + v;
  await setStepResult(tx, ctx, row.id, next, now);
  const overrides = await loadBaselineOverrides(tx, ctx);
  const m = stepMinutes(stepTypes[row.type] as never, row.payload as never, next as StepResult, overrides);
  await setStepSnapshot(
    tx,
    ctx,
    row.id,
    { baselineKey: m.baseline, units: m.units, minutesPerUnit: m.minutesPerUnit, minutesSaved: m.minutes },
    now,
  );
  await updateTask(tx, ctx, found.taskId, { minutesSaved: await minutesSavedOf(tx, ctx, found.taskId) }, now);
  return found.taskId;
}

// ---------------------------------------------------------------------------------------------
// G1 live tasks (Ruling GX-R): an agent's own one-step task that waits for nobody's yes.

/** A live task with exactly one step (any type, internal ones too). */
export type NewOneStepTask = Omit<NewTask, 'mode' | 'steps'> & { step: NewTask['steps'][number] };

/**
 * Creates a live task whose one step starts at once: the task is `running` and the step `queued`
 * (approved now, by nobody). The caller runs or enqueues the step after this transaction commits.
 */
export async function startLiveTask(
  tx: Tx,
  ctx: TenantContext,
  input: NewOneStepTask,
  now: Date,
): Promise<{ taskId: string; stepId: string }> {
  const { step, ...task } = input;
  const { taskId } = await createTask(tx, ctx, { ...task, mode: 'live', steps: [step] }, { now, ip: null, allowInternalStepTypes: true });
  const [row] = await listSteps(tx, ctx, [taskId]);
  if (!row) throw new Error('The task step was not saved.');
  if (!(await moveStep(tx, ctx, row.id, ['pending'], { status: 'queued', approvedAt: now }, now))) {
    throw new Error(`Step ${row.id} moved while its task was being made.`);
  }
  await updateTask(tx, ctx, taskId, { status: 'running' }, now);
  return { taskId, stepId: row.id };
}

/**
 * Writes a finished live note (Ruling GX-R): a record of something an agent did that needs no
 * approval and sends nothing. Its one internal no-op step is `done` with a `step_done` event (0 minutes:
 * a note saves no time), and `refreshTask` finishes the task with its `finished` event. Returns the task id.
 */
export async function writeLiveNote(
  tx: Tx,
  ctx: TenantContext,
  input: Omit<NewOneStepTask, 'step'> & { label: string },
  now: Date,
): Promise<string> {
  const { label, ...task } = input;
  const { taskId } = await createTask(
    tx,
    ctx,
    { ...task, mode: 'live', steps: [{ type: 'demo_noop', payload: { label } }] },
    { now, ip: null, allowInternalStepTypes: true },
  );
  await updateTask(tx, ctx, taskId, { status: 'running' }, now);
  const [row] = await listSteps(tx, ctx, [taskId]);
  const done = row ? await moveStep(tx, ctx, row.id, ['pending'], { status: 'done' }, now) : null;
  if (!done) throw new Error('The note step was not saved.');
  // A note saves nobody any time: no snapshot (the no-op's demo baseline would count 5 minutes), and its event says 0.
  // One millisecond apart, so the events read back in the order they happened (as createLiveTask).
  await event(tx, ctx, taskId, 'step_done', 'agent', { units: 0, minutes: 0 }, new Date(now.getTime() + 1), done.id);
  await refreshTask(tx, ctx, taskId, new Date(now.getTime() + 2));
  return taskId;
}

/** What the rerun route does next: re-draft a storm plan through Storm Scout, or copy the plan. */
export type StormRerunTarget = { kind: 'storm'; companyStormId: string } | { kind: 'copy' };

/**
 * Pre-flight for the rerun route. Null when the task is not there for this member. Only an expired
 * plan (409 otherwise). Anything but a storm plan is `copy` (nothing changed; `rerunTask` follows).
 * A storm plan that already has a rerun is a 409 ALREADY_RERUN; one a company storm points at
 * (`plan_task_id`) is re-drafted through Storm Scout; otherwise it is copied (a legacy plan with no
 * company storm). A stale draft is marked `expired` here, as `rerunTask` does, before the route
 * re-drafts in its own transaction.
 */
export async function prepareRerun(tx: Tx, ctx: TenantContext, taskId: string, opts: WriteOptions): Promise<StormRerunTarget | null> {
  if (!canReview(ctx)) return null;
  const task = await getTask(tx, ctx, taskId, { forUpdate: true });
  if (!task) return null;
  if (!isExpired(task, opts.now)) throw new AppError(409, RERUN_ONLY_EXPIRED);
  if (task.kind !== 'storm_plan') return { kind: 'copy' };
  if ((await findRerunOf(tx, ctx, taskId)) !== null) throw new AppError(409, ALREADY_RERUN);
  const companyStormId = await findStormByPlanTask(tx, ctx, taskId);
  if (companyStormId === null) return { kind: 'copy' };
  if (task.status === 'draft') {
    await updateTask(tx, ctx, taskId, { status: 'expired' }, opts.now);
    await event(tx, ctx, taskId, 'expired', 'system', {}, opts.now);
  }
  return { kind: 'storm', companyStormId };
}
