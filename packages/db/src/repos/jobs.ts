import { and, count, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { JOB_STAGE_LABELS, type JobSource, type JobStage, type StageMoveProblem, stageMoveProblem } from '@roofline/shared';
import { findPgError, ForbiddenError } from '../errors.ts';
import { jobs } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { audit } from './audit.ts';
import { type CustomerRow, getCustomer, type WriteOptions } from './customers.ts';
import { clampPage } from './paging.ts';
import { getProperty, linkPropertyToCustomer, type PropertyRow } from './properties.ts';
import { jobScope } from './scope.ts';

export type JobRow = typeof jobs.$inferSelect;

/**
 * A new job, made by `ctx.userId`. The caller (the API route) has already checked the shapes: ids
 * are UUIDs, the stage and source are real, the value is a whole number of cents, the reason is at
 * most 500 characters. Whether the things it points at exist and may be used is checked here.
 */
export type JobInput = {
  customerId: string;
  propertyId: string;
  /** Default 'lead'. */
  stage?: JobStage;
  /** Default 'manual'. */
  source?: JobSource;
  valueCents?: number | null;
  assignedUserId?: string | null;
  lostReason?: string | null;
  /** Trimmed; an empty text is stored as null. At most NEXT_STEP_MAX characters (the route checks). */
  nextStep?: string | null;
  /** The day the next step is due, 'YYYY-MM-DD'. */
  nextStepOn?: string | null;
};

/** Changes to a job. A field left out (undefined) is not touched; null clears the ones that can be cleared. */
export type JobPatch = {
  customerId?: string;
  propertyId?: string;
  stage?: JobStage;
  source?: JobSource;
  valueCents?: number | null;
  assignedUserId?: string | null;
  lostReason?: string | null;
  /** Trimmed; an empty text clears the next step. */
  nextStep?: string | null;
  /** 'YYYY-MM-DD', or null to clear the date. */
  nextStepOn?: string | null;
};

/**
 * What is wrong with something a job points at. The API reports each as a 400 on the matching field:
 * - `customer`: not a customer the member can see (`customerId`)
 * - `property`: not an address the member can see (`propertyId`)
 * - `propertyCustomer`: the address belongs to another customer (`propertyId`)
 * - `assignee`: not an active member of the company (`assignedUserId`)
 */
export type JobLinkProblem = 'customer' | 'property' | 'propertyCustomer' | 'assignee';

/** A stage change the pipeline rules refuse (see `stageMoveProblem`). The route maps it to a 400. */
export class StageRuleError extends Error {
  readonly problem: StageMoveProblem;

  constructor(problem: StageMoveProblem) {
    super(`That stage change is not allowed (${problem.problem}).`);
    this.name = 'StageRuleError';
    this.problem = problem;
  }
}

export class JobLinkError extends Error {
  readonly problem: JobLinkProblem;

  constructor(problem: JobLinkProblem) {
    super(`A job cannot point at that (${problem}).`);
    this.name = 'JobLinkError';
    this.problem = problem;
  }
}

/**
 * The last line of defence for the links: when a write still fails on one of the jobs foreign keys
 * (the customer or address vanished between the check and the write, or the checks were skipped),
 * this says which link it was. Undefined for any other error.
 */
export function jobLinkErrorFromPg(err: unknown): JobLinkError | undefined {
  const pg = findPgError(err);
  if (pg?.code !== '23503') return undefined;
  switch (pg.constraint) {
    case 'jobs_company_customer_fk':
      return new JobLinkError('customer');
    case 'jobs_company_property_fk':
      return new JobLinkError('property');
    case 'jobs_assigned_user_id_users_id_fk':
      return new JobLinkError('assignee');
    default:
      return undefined;
  }
}

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw jobLinkErrorFromPg(err) ?? err;
  }
}

/**
 * A rep may give a job to themselves or to nobody, never to someone else (R17). The route checks
 * this before anything else; this is the same rule at the data layer. Owner, office and system
 * may assign anyone.
 */
function assertMayAssign(ctx: TenantContext, assignedUserId: string | null | undefined): void {
  if (ctx.role === 'rep' && assignedUserId !== undefined && assignedUserId !== null && assignedUserId !== ctx.userId) {
    throw new ForbiddenError();
  }
}

/** The member's name when they are an active member of the company, else null. `company_members` is the only way the tenant role sees names. */
async function activeMemberName(tx: Tx, userId: string): Promise<string | null> {
  const result = await tx.execute(
    sql`select name from company_members where user_id = ${userId} and status = 'active' limit 1`,
  );
  const row = result.rows[0];
  return row ? (row.name as string) : null;
}

/**
 * Checks that a job may point at this customer and this address: the member can see both, and an
 * address that already has a customer belongs to this one. Returns both.
 */
async function checkLinks(
  tx: Tx,
  ctx: TenantContext,
  customerId: string,
  propertyId: string,
): Promise<{ customer: CustomerRow; property: PropertyRow }> {
  const customer = await getCustomer(tx, ctx, customerId);
  if (!customer) throw new JobLinkError('customer');
  const property = await getProperty(tx, ctx, propertyId);
  if (!property) throw new JobLinkError('property');
  if (property.customerId !== null && property.customerId !== customerId) throw new JobLinkError('propertyCustomer');
  return { customer, property };
}

/**
 * An address with a job always has a customer: a job at an address nobody owns yet makes the job's
 * customer its owner, in the same transaction (the address row is locked for the change, so a
 * second job for another customer made at the same moment is refused as "belongs to a different
 * customer"). Without this the customer's timeline ("New job: <address>") would name an address
 * that a rep who can see the customer could not open.
 */
async function claimAddress(
  tx: Tx,
  ctx: TenantContext,
  links: { customer: CustomerRow; property: PropertyRow },
  options: WriteOptions,
): Promise<void> {
  if (links.property.customerId !== null) return;
  const owned = await linkPropertyToCustomer(tx, ctx, links.property.id, links.customer, options);
  if (owned.customerId !== links.customer.id) throw new JobLinkError('propertyCustomer');
}

// ---------------------------------------------------------------------------------------------
// History helpers

const AUDITED = [
  'customerId',
  'propertyId',
  'stage',
  'stageChangedAt',
  'source',
  'valueCents',
  'assignedUserId',
  'lostReason',
  'nextStep',
  'nextStepOn',
] as const;
type AuditedField = (typeof AUDITED)[number];

/** The named fields of a job as plain JSON (dates as ISO strings), for the audit log. */
function snapshot(row: JobRow, fields: readonly AuditedField[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = row[field];
      return [field, value instanceof Date ? value.toISOString() : value];
    }),
  );
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * 'YYYY-MM-DD' as 'Oct 14', read from the digits alone: a due date is a calendar day, so no zone
 * is applied to it.
 */
function shortDate(ymd: string): string {
  const [, month, day] = ymd.split('-');
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}`;
}

/** The next step as stored: trimmed, null when empty; undefined stays undefined (not touched). */
function cleanNextStep(text: string | null | undefined): string | null | undefined {
  if (text === undefined || text === null) return text;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Writes the timeline line for a next step that was set, re-dated or cleared. Nothing is written
 * when neither the text nor the date changed, or when only the date changed and there is no text.
 */
async function addNextStepActivity(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  before: { nextStep: string | null; nextStepOn: string | null },
  after: { nextStep: string | null; nextStepOn: string | null },
  at: Date,
): Promise<void> {
  if (before.nextStep === after.nextStep && before.nextStepOn === after.nextStepOn) return;
  let summary: string;
  if (after.nextStep !== null) {
    const due = after.nextStepOn !== null ? ` (${shortDate(after.nextStepOn)})` : '';
    summary = `Next step: ${after.nextStep}${due}`;
  } else if (before.nextStep !== null) {
    summary = 'Next step cleared';
  } else {
    return;
  }
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: jobId,
    kind: 'job.next_step',
    summary,
    at,
  });
}

// ---------------------------------------------------------------------------------------------
// Reads

/** One job the member may see, or null (it does not exist, is another company's, or is outside a rep's scope). */
export async function getJob(tx: Tx, ctx: TenantContext, id: string): Promise<JobRow | null> {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), jobScope(ctx)))
    .limit(1);
  return row ?? null;
}

export type ListJobsOptions = {
  stage?: JobStage;
  /** 'me': assigned to the member. 'unassigned': assigned to nobody. */
  assigned?: 'me' | 'unassigned';
  customerId?: string;
  propertyId?: string;
  /** Default 50, at most 200. */
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
};

/** The jobs the member may see, newest first, with the count before paging. */
export async function listJobs(
  tx: Tx,
  ctx: TenantContext,
  options: ListJobsOptions = {},
): Promise<{ jobs: JobRow[]; total: number }> {
  const { limit, offset } = clampPage(options);
  const conditions: (SQL | undefined)[] = [jobScope(ctx)];
  if (options.includeArchived !== true) conditions.push(isNull(jobs.archivedAt));
  if (options.stage !== undefined) conditions.push(eq(jobs.stage, options.stage));
  if (options.assigned === 'me') conditions.push(ctx.userId === null ? sql`false` : eq(jobs.assignedUserId, ctx.userId));
  if (options.assigned === 'unassigned') conditions.push(isNull(jobs.assignedUserId));
  if (options.customerId !== undefined) conditions.push(eq(jobs.customerId, options.customerId));
  if (options.propertyId !== undefined) conditions.push(eq(jobs.propertyId, options.propertyId));

  const where = and(...conditions);
  const rows = await tx.select().from(jobs).where(where).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(limit).offset(offset);
  const [totals] = await tx.select({ total: count() }).from(jobs).where(where);
  return { jobs: rows, total: totals?.total ?? 0 };
}

// ---------------------------------------------------------------------------------------------
// Writes

/**
 * Adds a job, created by `ctx.userId`, at `now` in the given stage (default 'lead').
 * Throws `JobLinkError` when the customer or the address is not one the member can see, when the
 * address belongs to a different customer, or when `assignedUserId` is not an active member; and
 * `ForbiddenError` when a rep assigns someone other than themselves. An address that has no
 * customer yet becomes this customer's (see `claimAddress`).
 * Writes the audit row and the timeline: "Job created" on the job (plus "Assigned to ..." when it
 * starts out assigned) and "New job: <address>" on the customer.
 */
export async function createJob(tx: Tx, ctx: TenantContext, input: JobInput, options: WriteOptions): Promise<JobRow> {
  const { now } = options;
  assertMayAssign(ctx, input.assignedUserId);
  const links = await checkLinks(tx, ctx, input.customerId, input.propertyId);
  const { property } = links;
  // A stage given at creation follows the move rules from 'lead' (Won needs a value, Lost a reason), except
  // that a job may start Installed: a past job (the showcase seed, an import) was already Won before it was entered.
  if (input.stage !== undefined) {
    const problem = stageMoveProblem({
      from: input.stage === 'installed' ? 'won' : 'lead',
      to: input.stage,
      valueCents: input.valueCents ?? null,
      lostReason: input.lostReason ?? null,
    });
    if (problem) throw new StageRuleError(problem);
  }
  const assigneeName = input.assignedUserId ? await activeMemberName(tx, input.assignedUserId) : null;
  if (input.assignedUserId && assigneeName === null) throw new JobLinkError('assignee');
  await claimAddress(tx, ctx, links, options);

  const nextStep = cleanNextStep(input.nextStep) ?? null;
  const nextStepOn = input.nextStepOn ?? null;
  const [row] = await guarded(() =>
    tx
      .insert(jobs)
      .values({
        companyId: ctx.companyId,
        customerId: input.customerId,
        propertyId: input.propertyId,
        stage: input.stage ?? 'lead',
        stageChangedAt: now,
        source: input.source ?? 'manual',
        valueCents: input.valueCents ?? null,
        assignedUserId: input.assignedUserId ?? null,
        createdByUserId: ctx.userId,
        lostReason: input.lostReason ?? null,
        nextStep,
        nextStepOn,
        createdAt: now,
        updatedAt: now,
      })
      .returning(),
  );
  const created = row!;

  await audit(tx, ctx, {
    action: 'job.create',
    targetType: 'job',
    targetId: created.id,
    after: snapshot(created, AUDITED),
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: created.id,
    kind: 'job.created',
    summary: 'Job created',
    at: now,
  });
  await addNextStepActivity(tx, ctx, created.id, { nextStep: null, nextStepOn: null }, created, now);
  await addActivity(tx, ctx, {
    subjectType: 'customer',
    subjectId: created.customerId,
    kind: 'job.created',
    summary: `New job: ${property.addressLine}`,
    data: { jobId: created.id, propertyId: created.propertyId },
    at: now,
  });
  if (assigneeName !== null) {
    await addActivity(tx, ctx, {
      subjectType: 'job',
      subjectId: created.id,
      kind: 'job.assigned',
      summary: `Assigned to ${assigneeName}`,
      data: { from: null, to: created.assignedUserId },
      at: now,
    });
  }
  return created;
}

/**
 * Changes a job the member may see; null when they may not (or it does not exist). The row is
 * locked for the length of the transaction, so two edits of one job do not interleave.
 *
 * - A different customer or address is checked like a new job's (`JobLinkError`), and an address
 *   with no customer becomes this customer's; one the job already has is not checked again.
 * - A different stage sets `stage_changed_at` to `now` and adds "Moved to <Stage>". Sending the
 *   stage the job already has changes nothing. Moving a job away from 'lost' clears its lost
 *   reason in the same update (the audit after-image shows it), even if the patch names one.
 * - A different assignee (an active member, or null) adds "Assigned to <name>" or "Unassigned".
 *   A rep may only name themselves or null (`ForbiddenError`, checked before the job is looked up).
 * - A stage the pipeline rules refuse (`stageMoveProblem`) throws `StageRuleError` before anything is written.
 * - A changed next step or next-step date adds "Next step: <text> (Oct 14)" or "Next step cleared"
 *   (`addNextStepActivity`); a date change alone, with no text, adds nothing.
 * - Always writes the audit row: the fields the patch named, before and after. Value, source,
 *   lost-reason and next-step changes appear there only.
 */
export async function updateJob(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  patch: JobPatch,
  options: WriteOptions,
): Promise<JobRow | null> {
  const { now } = options;
  assertMayAssign(ctx, patch.assignedUserId);
  const [before] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), jobScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;

  // The pipeline rules are checked before anything is written (the address link below writes).
  if (patch.stage !== undefined) {
    const problem = stageMoveProblem({
      from: before.stage,
      to: patch.stage,
      // What will be stored: an explicit null in the patch clears the field, so it counts as null here.
      valueCents: patch.valueCents !== undefined ? patch.valueCents : before.valueCents,
      lostReason: patch.lostReason !== undefined ? patch.lostReason : before.lostReason,
    });
    if (problem) throw new StageRuleError(problem);
  }

  const set: Partial<typeof jobs.$inferInsert> = { updatedAt: now };
  const touched = new Set<AuditedField>();
  const nextStep = cleanNextStep(patch.nextStep);

  const newCustomer = patch.customerId !== undefined && patch.customerId !== before.customerId;
  const newProperty = patch.propertyId !== undefined && patch.propertyId !== before.propertyId;
  if (newCustomer || newProperty) {
    const links = await checkLinks(tx, ctx, patch.customerId ?? before.customerId, patch.propertyId ?? before.propertyId);
    await claimAddress(tx, ctx, links, options);
  }
  if (patch.customerId !== undefined) {
    set.customerId = patch.customerId;
    touched.add('customerId');
  }
  if (patch.propertyId !== undefined) {
    set.propertyId = patch.propertyId;
    touched.add('propertyId');
  }

  const stageChanged = patch.stage !== undefined && patch.stage !== before.stage;
  if (patch.stage !== undefined) {
    touched.add('stage');
    if (stageChanged) {
      set.stage = patch.stage;
      set.stageChangedAt = now;
      touched.add('stageChangedAt');
    }
  }
  if (patch.source !== undefined) {
    set.source = patch.source;
    touched.add('source');
  }
  if (patch.valueCents !== undefined) {
    set.valueCents = patch.valueCents;
    touched.add('valueCents');
  }
  if (patch.lostReason !== undefined) {
    set.lostReason = patch.lostReason;
    touched.add('lostReason');
  }
  if (nextStep !== undefined) {
    set.nextStep = nextStep;
    touched.add('nextStep');
  }
  if (patch.nextStepOn !== undefined) {
    set.nextStepOn = patch.nextStepOn;
    touched.add('nextStepOn');
  }
  // A job that is no longer lost has no reason for being lost, whatever else the patch sent.
  if (stageChanged && before.stage === 'lost') {
    set.lostReason = null;
    touched.add('lostReason');
  }

  const assigneeChanged = patch.assignedUserId !== undefined && patch.assignedUserId !== before.assignedUserId;
  let assigneeName: string | null = null;
  if (patch.assignedUserId !== undefined) {
    touched.add('assignedUserId');
    if (assigneeChanged) {
      if (patch.assignedUserId !== null) {
        assigneeName = await activeMemberName(tx, patch.assignedUserId);
        if (assigneeName === null) throw new JobLinkError('assignee');
      }
      set.assignedUserId = patch.assignedUserId;
    }
  }

  const [updated] = await guarded(() => tx.update(jobs).set(set).where(eq(jobs.id, id)).returning());
  const after = updated!;

  const fields = AUDITED.filter((field) => touched.has(field));
  await audit(tx, ctx, {
    action: 'job.update',
    targetType: 'job',
    targetId: id,
    before: snapshot(before, fields),
    after: snapshot(after, fields),
    ip: options.ip ?? null,
    at: now,
  });
  if (stageChanged) {
    await addActivity(tx, ctx, {
      subjectType: 'job',
      subjectId: id,
      kind: 'job.stage_changed',
      summary: `Moved to ${JOB_STAGE_LABELS[after.stage]}`,
      data: { from: before.stage, to: after.stage },
      at: now,
    });
  }
  if (assigneeChanged) {
    await addActivity(tx, ctx, {
      subjectType: 'job',
      subjectId: id,
      kind: 'job.assigned',
      summary: assigneeName === null ? 'Unassigned' : `Assigned to ${assigneeName}`,
      data: { from: before.assignedUserId, to: after.assignedUserId },
      at: now,
    });
  }
  await addNextStepActivity(
    tx,
    ctx,
    id,
    { nextStep: before.nextStep, nextStepOn: before.nextStepOn },
    { nextStep: after.nextStep, nextStepOn: after.nextStepOn },
    now,
  );
  return after;
}

/**
 * Archives or restores a job the member may see (null when they may not). There is no hard delete.
 * Doing it again changes nothing and writes nothing.
 */
export async function setJobArchived(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  archived: boolean,
  options: WriteOptions,
): Promise<JobRow | null> {
  const { now } = options;
  const [before] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), jobScope(ctx)))
    .limit(1)
    .for('update');
  if (!before) return null;
  if (archived === (before.archivedAt !== null)) return before;

  const [updated] = await tx
    .update(jobs)
    .set({ archivedAt: archived ? now : null, updatedAt: now })
    .where(eq(jobs.id, id))
    .returning();
  const after = updated!;

  await audit(tx, ctx, {
    action: archived ? 'job.archive' : 'job.unarchive',
    targetType: 'job',
    targetId: id,
    before: { archivedAt: before.archivedAt?.toISOString() ?? null },
    after: { archivedAt: after.archivedAt?.toISOString() ?? null },
    ip: options.ip ?? null,
    at: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: id,
    kind: archived ? 'job.archived' : 'job.unarchived',
    summary: archived ? 'Job archived' : 'Job restored',
    at: now,
  });
  return after;
}
