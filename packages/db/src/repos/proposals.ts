import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from 'drizzle-orm';
import {
  monthlyPaymentCents,
  priceTier,
  type AddOn,
  type Calculation,
  type MeasurementKind,
  type MeasuredQuantities,
  type Pricebook,
  type ProposalEventKind,
  type ProposalOptionView,
  type ProposalStatus,
  type ProposalView,
  type QuoteLine,
  type Scope,
  type Tier,
  type TierTemplate,
} from '@roofline/shared';
import {
  agentTaskSteps,
  agentTasks,
  companySettings,
  customers,
  jobs,
  measurements,
  messages,
  properties,
  proposalCounters,
  proposalEvents,
  proposalOptions,
  proposalSignatures,
  proposals,
  type CustomerPhone,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { clampPage } from './paging.ts';
import { jobScope } from './scope.ts';

/** One option to insert. `prices` is stored as { pricebook, addOnLines, quantities } (see Package 2 instructions). */
export type NewProposalOption = {
  tier: Tier; position: number; name: string; highlights: string[]; scope: Scope; addOns: AddOn[];
  calculation: Calculation; addOnLines: QuoteLine[]; pricebook: Pricebook; quantities: MeasuredQuantities;
  totalCents: number; monthlyEstimateCents: number | null; enabled: boolean;
};
export type NewProposal = {
  jobId: string; customerId: string; propertyId: string; measurementId: string; basis: MeasurementKind;
  validUntil: string; messageBody: string; options: NewProposalOption[];
};
/** Changes to a draft; option changes are keyed by option id (an id not on the proposal throws UnknownProposalOptionError). Only keys present change. */
export type ProposalPatch = {
  messageBody?: string;
  options?: { id: string; enabled?: boolean; name?: string; material?: Scope['material']; wastePercent?: number; markupPercent?: number; addOns?: AddOn[] }[];
};
/** What build needs from a measurement row (columns of `measurements`). */
export type MeasurementBasics = {
  id: string; propertyId: string; jobId: string | null; kind: MeasurementKind;
  surfaceSqFt: number; pitchX12: number; edgeFt: number; ridgeFt: number; valleyFt: number;
};

/** A patch named an option id that is not one of the proposal's options (or named one twice). `index` is its place in `options`. */
export class UnknownProposalOptionError extends Error {
  readonly index: number;
  constructor(index: number) {
    super('That option is not part of this proposal.');
    this.name = 'UnknownProposalOptionError';
    this.index = index;
  }
}

type StoredPrices = { pricebook: Pricebook; addOnLines: QuoteLine[]; quantities: MeasuredQuantities };

/** Allocates the next number for the company inside the caller's transaction. The conflict update locks the counter row, so concurrent creates serialize. */
export async function nextProposalNumber(tx: Tx, ctx: TenantContext): Promise<string> {
  const [row] = await tx
    .insert(proposalCounters)
    .values({ companyId: ctx.companyId, nextNumber: 2 })
    .onConflictDoUpdate({
      target: proposalCounters.companyId,
      set: { nextNumber: sql`${proposalCounters.nextNumber} + 1`, updatedAt: sql`now()` },
    })
    .returning({ nextNumber: proposalCounters.nextNumber });
  const allocated = (row?.nextNumber ?? 2) - 1;
  return `P-${String(allocated).padStart(4, '0')}`;
}

function optionRow(ctx: TenantContext, proposalId: string, o: NewProposalOption, now: Date): typeof proposalOptions.$inferInsert {
  const prices: StoredPrices = { pricebook: o.pricebook, addOnLines: o.addOnLines, quantities: o.quantities };
  return {
    companyId: ctx.companyId,
    proposalId,
    tier: o.tier,
    position: o.position,
    name: o.name,
    highlights: o.highlights,
    scope: o.scope as unknown as Record<string, unknown>,
    prices: prices as unknown as Record<string, unknown>,
    addOns: o.addOns,
    calculation: o.calculation as unknown as Record<string, unknown>,
    totalCents: o.totalCents,
    monthlyEstimateCents: o.monthlyEstimateCents,
    enabled: o.enabled,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createProposal(tx: Tx, ctx: TenantContext, p: NewProposal, now: Date): Promise<ProposalView> {
  const number = await nextProposalNumber(tx, ctx);
  const [row] = await tx
    .insert(proposals)
    .values({
      companyId: ctx.companyId,
      jobId: p.jobId,
      customerId: p.customerId,
      propertyId: p.propertyId,
      measurementId: p.measurementId,
      number,
      status: 'draft',
      validUntil: p.validUntil,
      // Placeholders: Task 11 overwrites both when it mints the real link token.
      linkTokenHash: randomBytes(32),
      linkTokenEncrypted: Buffer.alloc(0),
      messageBody: p.messageBody,
      estimateBasis: p.basis,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: proposals.id });
  if (!row) throw new Error('The proposal was not saved.');
  if (p.options.length > 0) {
    await tx.insert(proposalOptions).values(p.options.map((o) => optionRow(ctx, row.id, o, now)));
  }
  const view = await getProposal(tx, ctx, row.id);
  if (!view) throw new Error('The proposal was not found after saving.');
  return view;
}

function visibleJob(ctx: TenantContext): SQL | undefined {
  const scope = jobScope(ctx);
  if (!scope) return undefined;
  return sql`exists (select 1 from ${jobs} where ${jobs.id} = ${proposals.jobId} and ${scope})`;
}

function primaryPhone(phones: CustomerPhone[]): string | null {
  const list = phones ?? [];
  return (list.find((p) => p.primary) ?? list[0])?.e164 ?? null;
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

type ViewRow = { proposal: typeof proposals.$inferSelect; customerName: string; customerPhones: CustomerPhone[]; addressLine: string; city: string; state: string; zip: string };

async function viewsFor(tx: Tx, ctx: TenantContext, rows: ViewRow[]): Promise<ProposalView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.proposal.id);
  // The latest task that texts each proposal (its id is the proposal's `taskId`), by subject.
  const taskRows = await tx
    .select({ id: agentTasks.id, subjectId: agentTasks.subjectId })
    .from(agentTasks)
    .where(and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.subjectType, 'proposal'), inArray(agentTasks.subjectId, ids)))
    .orderBy(desc(agentTasks.createdAt));
  const taskByProposal = new Map<string, string>();
  for (const t of taskRows) if (t.subjectId !== null && !taskByProposal.has(t.subjectId)) taskByProposal.set(t.subjectId, t.id);
  const optionRows = await tx
    .select()
    .from(proposalOptions)
    .where(inArray(proposalOptions.proposalId, ids))
    .orderBy(asc(proposalOptions.position));
  const signatureRows = await tx.select().from(proposalSignatures).where(inArray(proposalSignatures.proposalId, ids));
  return rows.map(({ proposal: p, customerName, customerPhones, addressLine, city, state, zip }) => {
    const options: ProposalOptionView[] = optionRows
      .filter((o) => o.proposalId === p.id)
      .map((o) => ({
        id: o.id,
        tier: o.tier,
        name: o.name,
        highlights: o.highlights,
        scope: o.scope as unknown as Scope,
        addOns: o.addOns,
        calculation: o.calculation as unknown as Calculation,
        addOnLines: ((o.prices as Partial<StoredPrices>).addOnLines ?? []) as QuoteLine[],
        totalCents: o.totalCents,
        monthlyEstimateCents: o.monthlyEstimateCents,
        enabled: o.enabled,
      }));
    const sig = signatureRows.find((s) => s.proposalId === p.id);
    return {
      id: p.id,
      number: p.number,
      status: p.status,
      jobId: p.jobId,
      customer: { id: p.customerId, name: customerName, phone: primaryPhone(customerPhones) },
      address: `${addressLine}, ${city}, ${state} ${zip}`,
      measurementId: p.measurementId,
      basis: p.estimateBasis,
      options,
      messageBody: p.messageBody ?? '',
      validUntil: p.validUntil,
      sentAt: iso(p.sentAt),
      views: { count: p.viewCount, first: iso(p.firstViewedAt), last: iso(p.lastViewedAt) },
      signed: sig ? { optionId: sig.optionId, name: sig.signerName, at: sig.signedAt.toISOString() } : null,
      declined: p.declinedAt ? { reason: p.declineReason, at: p.declinedAt.toISOString() } : null,
      taskId: taskByProposal.get(p.id) ?? null,
      replacedById: p.replacedById,
      canEdit: p.status === 'draft',
    };
  });
}

function selectViewRows(tx: Tx, where: SQL | undefined) {
  return tx
    .select({
      proposal: proposals,
      customerName: customers.displayName,
      customerPhones: customers.phones,
      addressLine: properties.addressLine,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
    })
    .from(proposals)
    .innerJoin(customers, eq(customers.id, proposals.customerId))
    .innerJoin(properties, eq(properties.id, proposals.propertyId))
    .where(where);
}

export async function getProposal(tx: Tx, ctx: TenantContext, id: string): Promise<ProposalView | null> {
  const rows = await selectViewRows(tx, and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id), visibleJob(ctx))).limit(1);
  const [view] = await viewsFor(tx, ctx, rows as ViewRow[]);
  return view ?? null;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listProposals(tx: Tx, ctx: TenantContext, q: { status?: ProposalStatus; q?: string; offset?: number; signedOn?: string }): Promise<{ proposals: ProposalView[]; total: number }> {
  const conds: (SQL | undefined)[] = [eq(proposals.companyId, ctx.companyId), visibleJob(ctx)];
  if (q.status) conds.push(eq(proposals.status, q.status));
  const text = q.q?.trim();
  if (text) {
    const like = `%${escapeLike(text)}%`;
    conds.push(sql`(${proposals.number} ilike ${like} or ${customers.displayName} ilike ${like} or ${properties.addressLine} ilike ${like})`);
  }
  if (q.signedOn) {
    conds.push(
      sql`(${proposals.signedAt} at time zone (select c.timezone from companies c where c.id = ${ctx.companyId}))::date = ${q.signedOn}::date`,
    );
  }
  const where = and(...conds);
  const { offset, limit } = clampPage({ offset: q.offset });
  const [count] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(proposals)
    .innerJoin(customers, eq(customers.id, proposals.customerId))
    .innerJoin(properties, eq(properties.id, proposals.propertyId))
    .where(where);
  const rows = await selectViewRows(tx, where).orderBy(desc(proposals.createdAt), desc(proposals.number)).limit(limit).offset(offset);
  return { proposals: await viewsFor(tx, ctx, rows as ViewRow[]), total: count?.total ?? 0 };
}

async function financing(tx: Tx, ctx: TenantContext): Promise<{ aprBps: number; months: number } | null> {
  const [s] = await tx
    .select({ apr: companySettings.financingAprBps, months: companySettings.financingTermMonths })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return s && s.apr !== null && s.months !== null ? { aprBps: s.apr, months: s.months } : null;
}

/** The draft row if the member may see it: null when missing or hidden, 'not_draft' otherwise. */
async function draftRow(tx: Tx, ctx: TenantContext, id: string): Promise<typeof proposals.$inferSelect | 'not_draft' | null> {
  const [row] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id), visibleJob(ctx)))
    .limit(1)
    .for('update');
  if (!row) return null;
  return row.status === 'draft' ? row : 'not_draft';
}

export async function updateDraftProposal(tx: Tx, ctx: TenantContext, id: string, p: ProposalPatch, now: Date): Promise<ProposalView | 'not_draft' | null> {
  const row = await draftRow(tx, ctx, id);
  if (row === null || row === 'not_draft') return row;
  const options = await tx.select().from(proposalOptions).where(eq(proposalOptions.proposalId, id));
  const fin = await financing(tx, ctx);
  const known = new Set(options.map((o) => o.id));
  const patches = new Map<string, NonNullable<ProposalPatch['options']>[number]>();
  (p.options ?? []).forEach((o, index) => {
    if (!known.has(o.id) || patches.has(o.id)) throw new UnknownProposalOptionError(index);
    patches.set(o.id, o);
  });
  for (const o of options) {
    const patch = patches.get(o.id);
    const stored = o.prices as unknown as StoredPrices;
    let scope = o.scope as unknown as Scope;
    let calculation = o.calculation as unknown as Calculation;
    let addOnLines = stored.addOnLines;
    let totalCents = o.totalCents;
    let addOns = o.addOns;
    let name = o.name;
    let enabled = o.enabled;
    if (patch) {
      const template: TierTemplate = {
        tier: o.tier,
        name: patch.name ?? o.name,
        material: patch.material ?? scope.material,
        wastePercent: patch.wastePercent ?? scope.wastePercent,
        markupPercent: patch.markupPercent ?? scope.markupPercent,
        addOns: patch.addOns ?? o.addOns,
        highlights: o.highlights,
        enabled: patch.enabled ?? o.enabled,
      };
      const { material: _m, wastePercent: _w, markupPercent: _k, ...rest } = scope;
      void _m; void _w; void _k;
      const priced = priceTier(template, { ...rest, markupPercent: scope.markupPercent }, stored.pricebook, stored.quantities);
      scope = priced.scope;
      calculation = priced.calculation;
      addOnLines = priced.addOnLines;
      totalCents = priced.totalCents;
      addOns = template.addOns;
      name = template.name;
      enabled = template.enabled;
    }
    await tx
      .update(proposalOptions)
      .set({
        scope: scope as unknown as Record<string, unknown>,
        calculation: calculation as unknown as Record<string, unknown>,
        prices: { ...stored, addOnLines } as unknown as Record<string, unknown>,
        totalCents,
        addOns,
        name,
        enabled,
        monthlyEstimateCents: fin ? monthlyPaymentCents(totalCents, fin.aprBps, fin.months) : null,
        updatedAt: now,
      })
      .where(eq(proposalOptions.id, o.id));
  }
  await tx
    .update(proposals)
    .set({ ...(p.messageBody !== undefined ? { messageBody: p.messageBody } : {}), updatedAt: now })
    .where(eq(proposals.id, id));
  return getProposal(tx, ctx, id);
}

export async function getMeasurementBasics(tx: Tx, ctx: TenantContext, id: string): Promise<MeasurementBasics | null> {
  const [m] = await tx
    .select()
    .from(measurements)
    .where(and(eq(measurements.companyId, ctx.companyId), eq(measurements.id, id)))
    .limit(1);
  if (!m) return null;
  return {
    id: m.id,
    propertyId: m.propertyId,
    jobId: m.jobId,
    kind: m.kind,
    surfaceSqFt: m.surfaceSqFt ?? 0,
    pitchX12: m.pitchX12 ?? 6,
    edgeFt: m.edgeFt ?? 0,
    ridgeFt: m.ridgeFt ?? 0,
    valleyFt: m.valleyFt ?? 0,
  };
}

/** Replaces a draft's options and basis in place (used by reprice). Returns null when not found, 'not_draft' otherwise. */
export async function replaceDraftOptions(tx: Tx, ctx: TenantContext, id: string, p: { basis: MeasurementKind; measurementId: string; options: NewProposalOption[] }, now: Date): Promise<ProposalView | 'not_draft' | null> {
  const row = await draftRow(tx, ctx, id);
  if (row === null || row === 'not_draft') return row;
  // app_tenant has no DELETE on proposal_options (0016): upsert each tier in place instead.
  for (const o of p.options) {
    const row = optionRow(ctx, id, o, now);
    const fields = { ...row, companyId: undefined, proposalId: undefined, tier: undefined, createdAt: undefined };
    await tx
      .insert(proposalOptions)
      .values(row)
      .onConflictDoUpdate({ target: [proposalOptions.proposalId, proposalOptions.tier], set: fields });
  }
  await tx.update(proposals).set({ measurementId: p.measurementId, estimateBasis: p.basis, updatedAt: now }).where(eq(proposals.id, id));
  return getProposal(tx, ctx, id);
}

// ---------------------------------------------------------------------------------------------
// Sending (E1 Task 11: estimator/send-proposal.ts and proposal-sent.ts)

/** Task statuses that mean a send is already queued or under way: asking again returns that task. */
const OPEN_SEND_TASK_STATUSES = ['draft', 'awaiting_owner', 'approved', 'running'] as const;

/** The proposal's row for a send, locked for the rest of the transaction, or null when it is missing or hidden from the member. */
export async function lockProposalForSend(
  tx: Tx,
  ctx: TenantContext,
  id: string,
): Promise<{ status: ProposalStatus; signed: boolean; linkTokenEncrypted: Buffer } | null> {
  const [row] = await tx
    .select({
      status: proposals.status,
      signedAt: proposals.signedAt,
      linkTokenEncrypted: proposals.linkTokenEncrypted,
    })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id), visibleJob(ctx)))
    .limit(1)
    .for('update');
  if (!row) return null;
  return { status: row.status, signed: row.signedAt !== null, linkTokenEncrypted: row.linkTokenEncrypted };
}

/** The assigned user of a proposal's job, or undefined when the proposal is not found or its job is not visible to ctx. */
export async function proposalJobAssignee(tx: Tx, ctx: TenantContext, proposalId: string): Promise<{ assignedUserId: string | null } | undefined> {
  const [row] = await tx
    .select({ assignedUserId: jobs.assignedUserId })
    .from(proposals)
    .innerJoin(jobs, and(eq(jobs.id, proposals.jobId), eq(jobs.companyId, proposals.companyId)))
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId), visibleJob(ctx)))
    .limit(1);
  return row ? { assignedUserId: row.assignedUserId } : undefined;
}

/** The stored encrypted link token (an empty Buffer until the first send), or null when the proposal is not found or not visible. */
export async function getProposalLinkToken(tx: Tx, ctx: TenantContext, proposalId: string): Promise<Buffer | null> {
  const [row] = await tx
    .select({ encrypted: proposals.linkTokenEncrypted })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId), visibleJob(ctx)))
    .limit(1);
  return row?.encrypted ?? null;
}

/** The id of a task that already texts this proposal and is open or under way (a send_proposal step on it), or null. */
export async function findOpenSendTask(tx: Tx, ctx: TenantContext, proposalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .innerJoin(
      agentTaskSteps,
      and(eq(agentTaskSteps.taskId, agentTasks.id), eq(agentTaskSteps.companyId, agentTasks.companyId)),
    )
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.subjectType, 'proposal'),
        eq(agentTasks.subjectId, proposalId),
        inArray(agentTasks.status, [...OPEN_SEND_TASK_STATUSES]),
        eq(agentTaskSteps.type, 'send_proposal'),
      ),
    )
    .orderBy(desc(agentTasks.createdAt))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Stores the link token's hash and encrypted form, but only while the proposal has none (its placeholder
 * is empty). Returns the encrypted token that is stored, whichever run wrote it: a link is minted once
 * and never changes, so a resend or a signed proposal keeps its link.
 */
export async function mintProposalLink(tx: Tx, ctx: TenantContext, proposalId: string, hash: Buffer, encrypted: Buffer): Promise<Buffer> {
  const written = await tx
    .update(proposals)
    .set({ linkTokenHash: hash, linkTokenEncrypted: encrypted })
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        eq(proposals.id, proposalId),
        sql`octet_length(${proposals.linkTokenEncrypted}) = 0`,
      ),
    )
    .returning({ encrypted: proposals.linkTokenEncrypted });
  if (written[0]) return written[0].encrypted;
  const [row] = await tx
    .select({ encrypted: proposals.linkTokenEncrypted })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)))
    .limit(1);
  if (!row) throw new Error('The proposal was not found.');
  return row.encrypted;
}

/** Moves a proposal from one of `from` to `to` (and sets `sentAt` when given). Returns false when its status is not one of `from`. */
export async function setProposalStatus(
  tx: Tx,
  ctx: TenantContext,
  id: string,
  from: readonly ProposalStatus[],
  to: ProposalStatus,
  now: Date,
  sentAt?: Date,
): Promise<boolean> {
  const rows = await tx
    .update(proposals)
    .set({ status: to, updatedAt: now, ...(sentAt !== undefined && { sentAt }) })
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id), inArray(proposals.status, [...from])))
    .returning({ id: proposals.id });
  return rows.length > 0;
}

/** What the sent proposal's job move and activity need: its number, job and customer. */
export type SentProposalCore = { id: string; number: string; jobId: string; customerId: string };

/** Marks the proposal sent (sent_at = now) only while it is one of `from`; returns its core fields, or null when it was not. */
export async function markProposalSent(tx: Tx, ctx: TenantContext, id: string, from: readonly ProposalStatus[], now: Date): Promise<SentProposalCore | null> {
  const rows = await tx
    .update(proposals)
    .set({ status: 'sent', sentAt: now, updatedAt: now })
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id), inArray(proposals.status, [...from])))
    .returning({ id: proposals.id, number: proposals.number, jobId: proposals.jobId, customerId: proposals.customerId });
  return rows[0] ?? null;
}

/** Appends one event to a proposal's history. */
export async function addProposalEvent(
  tx: Tx,
  ctx: TenantContext,
  e: { proposalId: string; kind: ProposalEventKind; at: Date; data?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(proposalEvents).values({
    companyId: ctx.companyId,
    proposalId: e.proposalId,
    kind: e.kind,
    data: e.data ?? {},
    at: e.at,
  });
}

/**
 * The sent proposal this one revises: the latest sent or viewed proposal of the same job and customer,
 * never a signed one. It becomes 'replaced' (replaced_by_id = this one). Returns its id, or null.
 */
export async function markReplacedProposal(
  tx: Tx,
  ctx: TenantContext,
  p: { proposalId: string; jobId: string; customerId: string; now: Date },
): Promise<string | null> {
  const [old] = await tx
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        eq(proposals.jobId, p.jobId),
        eq(proposals.customerId, p.customerId),
        ne(proposals.id, p.proposalId),
        inArray(proposals.status, ['sent', 'viewed']),
        ne(proposals.status, 'signed'),
        isNull(proposals.replacedById),
      ),
    )
    .orderBy(desc(proposals.sentAt))
    .limit(1);
  if (!old) return null;
  const rows = await tx
    .update(proposals)
    .set({ status: 'replaced', replacedById: p.proposalId, updatedAt: p.now })
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        eq(proposals.id, old.id),
        inArray(proposals.status, ['sent', 'viewed']),
        ne(proposals.status, 'signed'),
      ),
    )
    .returning({ id: proposals.id });
  return rows[0]?.id ?? null;
}

/** The blocked or failed text's reason for one customer of a step, as a person can read it, or null. */
export async function stepTextReason(tx: Tx, ctx: TenantContext, stepId: string, customerId: string): Promise<string | null> {
  const [row] = await tx
    .select({ reason: messages.blockReason })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.stepId, stepId), eq(messages.customerId, customerId)))
    .limit(1);
  return row?.reason ?? null;
}
