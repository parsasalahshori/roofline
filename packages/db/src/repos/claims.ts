import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type {
  ClaimBoardRow,
  ClaimEventActor,
  ClaimIntakeView,
  ClaimStatus,
  ClaimView,
  JobClaimResponse,
} from '@roofline/shared';
import { appointments, claimEvents, claimIntakes, claims, customers, jobs, properties } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { audit } from './audit.ts';
import { latestClaimPacket } from './claim-packet.ts';
import { jobScope } from './scope.ts';

/** The fields a person may save on a claim. Absent = leave alone; null = clear. */
export type ClaimPatch = Partial<{
  insurer: string | null;
  claimNumber: string | null;
  dateOfLoss: string | null;
  status: ClaimStatus;
  adjusterName: string | null;
  adjusterPhone: string | null;
  adjusterEmail: string | null;
  adjusterAppointmentId: string | null;
  deductibleCents: number | null;
  notes: string | null;
}>;

/** Thrown when a saved field is refused; the route turns it into `{ error, field }`. */
export class ClaimFieldError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
  }
}

type ClaimRow = typeof claims.$inferSelect;
type ClaimEvents = ClaimView['events'];

/** The intake fields a new claim takes from the job's latest intake when the patch leaves them out. */
const PREFILL_FIELDS = ['insurer', 'claimNumber', 'dateOfLoss'] as const;

/** The member's name from `company_members` (the only name the tenant role reads); null for the agent or an unknown user. */
const eventByName = sql<string | null>`(select m.name from company_members m where m.user_id = ${claimEvents.byUserId} limit 1)`;

/** The fields of a patch that were actually given (undefined = absent). */
function definedFields(patch: ClaimPatch): ClaimPatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as ClaimPatch;
}

/** Whether the job exists and the member may see it. */
async function jobIsVisible(tx: Tx, ctx: TenantContext, jobId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), jobScope(ctx)))
    .limit(1);
  return row !== undefined;
}

async function loadClaimRow(tx: Tx, jobId: string): Promise<ClaimRow | null> {
  const [row] = await tx.select().from(claims).where(eq(claims.jobId, jobId)).limit(1);
  return row ?? null;
}

async function loadLatestIntake(tx: Tx, jobId: string): Promise<typeof claimIntakes.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(claimIntakes)
    .where(eq(claimIntakes.jobId, jobId))
    .orderBy(desc(claimIntakes.createdAt), desc(claimIntakes.id))
    .limit(1);
  return row ?? null;
}

async function loadEvents(tx: Tx, claimId: string): Promise<ClaimEvents> {
  const rows = await tx
    .select({
      from: claimEvents.fromStatus,
      to: claimEvents.toStatus,
      by: claimEvents.by,
      byName: eventByName,
      at: claimEvents.at,
    })
    .from(claimEvents)
    .where(eq(claimEvents.claimId, claimId))
    .orderBy(asc(claimEvents.at), asc(claimEvents.id));
  return rows.map((row) => ({
    from: row.from,
    to: row.to,
    by: row.by,
    byName: row.byName,
    at: row.at.toISOString(),
  }));
}

function toClaimView(row: ClaimRow, events: ClaimEvents): ClaimView {
  return {
    id: row.id,
    jobId: row.jobId,
    insurer: row.insurer,
    claimNumber: row.claimNumber,
    dateOfLoss: row.dateOfLoss,
    status: row.status,
    adjusterName: row.adjusterName,
    adjusterPhone: row.adjusterPhone,
    adjusterEmail: row.adjusterEmail,
    adjusterAppointmentId: row.adjusterAppointmentId,
    deductibleCents: row.deductibleCents,
    notes: row.notes,
    statusChangedAt: row.statusChangedAt.toISOString(),
    events,
  };
}

function toIntakeView(row: typeof claimIntakes.$inferSelect): ClaimIntakeView {
  return {
    insurer: row.insurer,
    claimNumber: row.claimNumber,
    dateOfLoss: row.dateOfLoss,
    description: row.description,
    adjusterVisitAt: row.adjusterVisitAt ? row.adjusterVisitAt.toISOString() : null,
  };
}

/** Refuses an appointment that is not on this job (or not in this company). */
async function assertAppointmentOnJob(tx: Tx, ctx: TenantContext, jobId: string, appointmentId: string): Promise<void> {
  const [row] = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.jobId, jobId),
        eq(appointments.companyId, ctx.companyId),
      ),
    )
    .limit(1);
  if (!row) throw new ClaimFieldError('adjusterAppointmentId', 'Pick an appointment on this job.');
}

/** The job's claim and, while there is none, its latest intake. Null when the job is not visible to the member. */
export async function getJobClaim(tx: Tx, ctx: TenantContext, jobId: string): Promise<JobClaimResponse | null> {
  if (!(await jobIsVisible(tx, ctx, jobId))) return null;
  const row = await loadClaimRow(tx, jobId);
  if (row) {
    // G1 Task 7
    const built = await latestClaimPacket(tx, ctx, row.id);
    const packet = built ? { storedFileId: built.storedFileId, builtAt: built.builtAt.toISOString() } : null;
    return { claim: toClaimView(row, await loadEvents(tx, row.id)), intake: null, packet };
  }
  const intake = await loadLatestIntake(tx, jobId);
  return { claim: null, intake: intake ? toIntakeView(intake) : null, packet: null };
}

/**
 * Creates the job's claim on first save, or updates the given fields. Null when the job is not
 * visible to the member. A status change writes a `claim_events` row and sets `status_changed_at`;
 * the audit row names the changed fields only, never their values.
 */
export async function saveClaim(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  patch: ClaimPatch,
  by: { actor: ClaimEventActor; userId: string | null },
  now: Date,
): Promise<ClaimView | null> {
  if (!(await jobIsVisible(tx, ctx, jobId))) return null;
  if (typeof patch.adjusterAppointmentId === 'string') {
    await assertAppointmentOnJob(tx, ctx, jobId, patch.adjusterAppointmentId);
  }
  const existing = await loadClaimRow(tx, jobId);
  if (existing) return updateClaim(tx, ctx, existing, patch, by, now);
  return createClaim(tx, ctx, jobId, patch, by, now);
}

async function createClaim(
  tx: Tx,
  ctx: TenantContext,
  jobId: string,
  patch: ClaimPatch,
  by: { actor: ClaimEventActor; userId: string | null },
  now: Date,
): Promise<ClaimView> {
  const given = definedFields(patch);
  const intake = await loadLatestIntake(tx, jobId);
  const fromIntake: ClaimPatch = {};
  const prefilled: string[] = [];
  if (intake) {
    for (const key of PREFILL_FIELDS) {
      const value = intake[key];
      if (given[key] === undefined && value !== null) {
        fromIntake[key] = value;
        prefilled.push(key);
      }
    }
  }
  const merged: ClaimPatch = { ...fromIntake, ...given };
  const status = merged.status ?? 'not_filed';

  const [inserted] = await tx
    .insert(claims)
    .values({
      companyId: ctx.companyId,
      jobId,
      insurer: merged.insurer ?? null,
      claimNumber: merged.claimNumber ?? null,
      dateOfLoss: merged.dateOfLoss ?? null,
      status,
      adjusterName: merged.adjusterName ?? null,
      adjusterPhone: merged.adjusterPhone ?? null,
      adjusterEmail: merged.adjusterEmail ?? null,
      adjusterAppointmentId: merged.adjusterAppointmentId ?? null,
      deductibleCents: merged.deductibleCents ?? null,
      notes: merged.notes ?? null,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [claims.companyId, claims.jobId] })
    .returning();

  // A concurrent first save made the claim between the check and the insert: update that one instead.
  if (!inserted) {
    const existing = await loadClaimRow(tx, jobId);
    if (!existing) throw new Error('claim missing after a conflicting insert');
    return updateClaim(tx, ctx, existing, patch, by, now);
  }

  await tx.insert(claimEvents).values({
    companyId: ctx.companyId,
    claimId: inserted.id,
    fromStatus: null,
    toStatus: status,
    by: by.actor,
    byUserId: by.userId,
    at: now,
  });
  await audit(tx, ctx, {
    action: 'claim.created',
    targetType: 'claim',
    targetId: inserted.id,
    after: { fields: [...Object.keys(given), ...prefilled] },
    at: now,
  });
  return toClaimView(inserted, await loadEvents(tx, inserted.id));
}

async function updateClaim(
  tx: Tx,
  ctx: TenantContext,
  existing: ClaimRow,
  patch: ClaimPatch,
  by: { actor: ClaimEventActor; userId: string | null },
  now: Date,
): Promise<ClaimView> {
  const given = definedFields(patch);
  const changed = (Object.keys(given) as (keyof ClaimPatch)[]).filter((key) => existing[key] !== given[key]);

  const set: Partial<typeof claims.$inferInsert> = { ...given, updatedAt: now };
  if (given.status !== undefined && given.status !== existing.status) {
    await tx.insert(claimEvents).values({
      companyId: ctx.companyId,
      claimId: existing.id,
      fromStatus: existing.status,
      toStatus: given.status,
      by: by.actor,
      byUserId: by.userId,
      at: now,
    });
    set.statusChangedAt = now;
  }

  const [updated] = await tx.update(claims).set(set).where(eq(claims.id, existing.id)).returning();
  const row = updated ?? existing;
  if (changed.length > 0) {
    await audit(tx, ctx, {
      action: 'claim.updated',
      targetType: 'claim',
      targetId: row.id,
      after: { fields: changed },
      at: now,
    });
  }
  return toClaimView(row, await loadEvents(tx, row.id));
}

/** The claims board: the company's claims on jobs the member may see, newest status change first. */
export async function listClaims(
  tx: Tx,
  ctx: TenantContext,
  opts: { status?: ClaimStatus },
): Promise<ClaimBoardRow[]> {
  const rows = await tx
    .select({
      claimId: claims.id,
      jobId: claims.jobId,
      customerName: customers.displayName,
      addressLine: properties.addressLine,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
      status: claims.status,
      insurer: claims.insurer,
      claimNumber: claims.claimNumber,
      statusChangedAt: claims.statusChangedAt,
    })
    .from(claims)
    .innerJoin(jobs, eq(jobs.id, claims.jobId))
    .innerJoin(customers, eq(customers.id, jobs.customerId))
    .innerJoin(properties, eq(properties.id, jobs.propertyId))
    .where(and(opts.status ? eq(claims.status, opts.status) : undefined, jobScope(ctx)))
    .orderBy(desc(claims.statusChangedAt), asc(claims.id))
    .limit(500);
  return rows.map((row) => ({
    claimId: row.claimId,
    jobId: row.jobId,
    customerName: row.customerName,
    address: `${row.addressLine}, ${row.city}, ${row.state} ${row.zip}`,
    status: row.status,
    insurer: row.insurer,
    claimNumber: row.claimNumber,
    statusChangedAt: row.statusChangedAt.toISOString(),
  }));
}
