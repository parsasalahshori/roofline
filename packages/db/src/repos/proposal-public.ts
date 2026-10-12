import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PublicProposalView, ProposalEventKind, ProposalStatus, SignatureRecord } from '@roofline/shared';
import {
  companies,
  companySettings,
  customers,
  jobs,
  properties,
  proposalEvents,
  proposalOptions,
  proposalSignatures,
  proposals,
  storedFiles,
} from '../schema/index.ts';
import { isUniqueViolation } from '../errors.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';
import { updateJob } from './jobs.ts';
import { lockJobProposalsOf } from './proposals.ts';

/*
 * What the homeowner's link reads and writes. Everything runs in the caller's withTenant
 * transaction for the company the token resolved to, and filters by that company. The context is
 * the 'system' role, so the rep job scope is not used here.
 */

type ProposalRow = typeof proposals.$inferSelect;

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isExpired(p: { status: ProposalStatus; validUntil: string }, now: Date): boolean {
  return p.status === 'expired' || p.validUntil < today(now);
}

async function companyPhone(tx: Tx, ctx: TenantContext): Promise<string | null> {
  const [row] = await tx.select({ phone: companies.phoneE164 }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  return row?.phone ?? null;
}

async function settingsFor(tx: Tx, ctx: TenantContext) {
  const [row] = await tx
    .select({
      apr: companySettings.financingAprBps,
      months: companySettings.financingTermMonths,
      clause: companySettings.estimateChangeClause,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return row ?? null;
}

async function lockProposal(tx: Tx, ctx: TenantContext, id: string): Promise<ProposalRow | null> {
  const [row] = await tx
    .select()
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, id)))
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function publicProposalView(tx: Tx, ctx: TenantContext, proposalId: string, now: Date): Promise<PublicProposalView> {
  const [row] = await tx
    .select({
      proposal: proposals,
      customerName: customers.displayName,
      addressLine: properties.addressLine,
      city: properties.city,
      state: properties.state,
      zip: properties.zip,
    })
    .from(proposals)
    .innerJoin(customers, eq(customers.id, proposals.customerId))
    .innerJoin(properties, eq(properties.id, proposals.propertyId))
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)))
    .limit(1);
  if (!row) throw new Error('The proposal was not found.');
  const p = row.proposal;
  const [company] = await tx.select({ name: companies.name, phone: companies.phoneE164 }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const settings = await settingsFor(tx, ctx);
  const optionRows = await tx
    .select()
    .from(proposalOptions)
    .where(and(eq(proposalOptions.companyId, ctx.companyId), eq(proposalOptions.proposalId, proposalId), eq(proposalOptions.enabled, true)))
    .orderBy(asc(proposalOptions.position));
  const [sig] = await tx
    .select()
    .from(proposalSignatures)
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), eq(proposalSignatures.proposalId, proposalId)))
    .limit(1);

  const financingTerms = settings && settings.apr !== null && settings.months !== null ? { aprBps: settings.apr, months: settings.months } : null;
  const first = row.customerName.trim().split(/\s+/)[0] ?? '';
  let status: PublicProposalView['status'] = 'open';
  if (p.signedAt) status = 'signed';
  else if (p.declinedAt) status = 'declined';
  else if (isExpired({ status: p.status, validUntil: p.validUntil }, now)) status = 'expired';

  return {
    companyName: company?.name ?? '',
    companyPhone: company?.phone ?? null,
    firstName: first === '' ? null : first,
    address: `${row.addressLine}, ${row.city}, ${row.state} ${row.zip}`,
    validUntil: p.validUntil,
    status,
    basis: p.estimateBasis,
    options: optionRows.map((o) => ({
      id: o.id,
      tier: o.tier,
      name: o.name,
      highlights: o.highlights,
      // Homeowner-safe lines only: the highlights and the add-on names, never prices or the calculation.
      inclusions: [...o.highlights, ...o.addOns.map((a) => a.name)],
      totalCents: o.totalCents,
      monthlyEstimateCents: o.monthlyEstimateCents,
      financingTerms,
    })),
    signed: sig ? { optionId: sig.optionId, name: sig.signerName, at: sig.signedAt.toISOString(), pdfReady: sig.pdfFileId !== null } : null,
    estimateClause: p.estimateBasis === 'estimate' && (settings?.clause ?? true),
  };
}

export async function publicProposalState(
  tx: Tx,
  ctx: TenantContext,
  proposalId: string,
): Promise<{ status: ProposalStatus; validUntil: string; estimateClause: boolean; companyPhone: string | null } | null> {
  const [p] = await tx
    .select({ status: proposals.status, validUntil: proposals.validUntil, basis: proposals.estimateBasis })
    .from(proposals)
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)))
    .limit(1);
  if (!p) return null;
  const settings = await settingsFor(tx, ctx);
  return {
    status: p.status,
    validUntil: p.validUntil,
    estimateClause: p.basis === 'estimate' && (settings?.clause ?? true),
    companyPhone: await companyPhone(tx, ctx),
  };
}

export async function signedPdfFile(tx: Tx, ctx: TenantContext, proposalId: string): Promise<{ objectKey: string; contentType: string } | null> {
  const [row] = await tx
    .select({ objectKey: storedFiles.objectKey, contentType: storedFiles.contentType })
    .from(proposalSignatures)
    .innerJoin(storedFiles, and(eq(storedFiles.companyId, proposalSignatures.companyId), eq(storedFiles.id, proposalSignatures.pdfFileId)))
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), eq(proposalSignatures.proposalId, proposalId)))
    .limit(1);
  return row ?? null;
}

export async function recordProposalEvent(
  tx: Tx,
  ctx: TenantContext,
  proposalId: string,
  e: { kind: ProposalEventKind; data?: Record<string, unknown>; ipHash: string; userAgent: string },
  now: Date,
): Promise<void> {
  if (e.kind === 'viewed') {
    const p = await lockProposal(tx, ctx, proposalId);
    if (!p) return;
    const firstView = p.firstViewedAt === null;
    const set: Partial<typeof proposals.$inferInsert> = {
      lastViewedAt: now,
      viewCount: sql`${proposals.viewCount} + 1` as unknown as number,
    };
    if (firstView) set.firstViewedAt = now;
    if (p.status === 'sent') set.status = 'viewed';
    await tx.update(proposals).set(set).where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)));
    if (firstView) {
      const [who] = await tx.select({ name: customers.displayName }).from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, p.customerId))).limit(1);
      const first = who?.name.trim().split(/\s+/)[0] ?? '';
      await addActivity(tx, ctx, {
        subjectType: 'job',
        subjectId: p.jobId,
        kind: 'proposal.viewed',
        summary: `${first === '' ? 'The customer' : first} opened the proposal`,
        data: { proposalId },
        at: now,
      });
    }
  }
  await tx.insert(proposalEvents).values({
    companyId: ctx.companyId,
    proposalId,
    kind: e.kind,
    data: e.data ?? {},
    ipHash: e.ipHash,
    userAgent: e.userAgent,
    at: now,
    createdAt: now,
    updatedAt: now,
  });
}

export async function signProposal(
  tx: Tx,
  ctx: TenantContext,
  proposalId: string,
  s: Omit<SignatureRecord, 'documentSha256'> & { documentSha256: string },
  now: Date,
): Promise<'signed' | 'already_signed' | 'closed'> {
  // C-M1: signing changes every open proposal of the job, so they are all locked first, in id order (as a send does).
  await lockJobProposalsOf(tx, ctx, proposalId);
  const p = await lockProposal(tx, ctx, proposalId);
  if (!p) return 'closed';
  if (p.signedAt !== null) return 'already_signed';
  const [existing] = await tx
    .select({ id: proposalSignatures.id })
    .from(proposalSignatures)
    .where(and(eq(proposalSignatures.companyId, ctx.companyId), eq(proposalSignatures.proposalId, proposalId)))
    .limit(1);
  if (existing) return 'already_signed';
  if ((p.status !== 'sent' && p.status !== 'viewed') || p.validUntil < today(now)) return 'closed';
  const [option] = await tx
    .select()
    .from(proposalOptions)
    .where(
      and(
        eq(proposalOptions.companyId, ctx.companyId),
        eq(proposalOptions.proposalId, proposalId),
        eq(proposalOptions.id, s.optionId),
        eq(proposalOptions.enabled, true),
      ),
    )
    .limit(1);
  if (!option) return 'closed';

  try {
    // A savepoint, so a lost race on the unique key leaves the caller's transaction usable.
    await tx.transaction(async (sp) => {
      await sp.insert(proposalSignatures).values({
        companyId: ctx.companyId,
        proposalId,
        optionId: option.id,
        signerName: s.signerName,
        typedSignature: s.typedSignature,
        drawnSignaturePngSha256: s.drawnSignaturePngSha256,
        consentText: s.consentText,
        consentVersion: s.consentVersion,
        documentSha256: s.documentSha256,
        totalCents: option.totalCents,
        ip: s.ip,
        userAgent: s.userAgent,
        signedAt: now,
        viewedFirstAt: s.viewedFirstAt ? new Date(s.viewedFirstAt) : p.firstViewedAt,
        createdAt: now,
        updatedAt: now,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return 'already_signed';
    throw err;
  }

  await tx
    .update(proposals)
    .set({ status: 'signed', signedAt: now, updatedAt: now })
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)));

  const [job] = await tx.select().from(jobs).where(and(eq(jobs.companyId, ctx.companyId), eq(jobs.id, p.jobId))).limit(1);
  if (job && job.stage !== 'won' && job.stage !== 'installed') {
    await updateJob(tx, ctx, p.jobId, { stage: 'won', valueCents: option.totalCents }, { now });
  }

  await tx
    .update(proposals)
    .set({ status: 'replaced', replacedById: proposalId, updatedAt: now })
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        eq(proposals.jobId, p.jobId),
        ne(proposals.id, proposalId),
        inArray(proposals.status, ['sent', 'viewed', 'ready', 'draft']),
      ),
    );

  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: p.jobId,
    kind: 'proposal.signed',
    summary: `${s.signerName} signed the proposal (${p.number})`,
    data: { proposalId, optionId: option.id, totalCents: option.totalCents },
    at: now,
  });
  await tx.insert(proposalEvents).values({
    companyId: ctx.companyId,
    proposalId,
    kind: 'signed',
    data: { optionId: option.id },
    ipHash: createHash('sha256').update(`${s.ip}${ctx.companyId}`).digest('hex'),
    userAgent: s.userAgent,
    at: now,
    createdAt: now,
    updatedAt: now,
  });
  return 'signed';
}

export async function declineProposal(tx: Tx, ctx: TenantContext, proposalId: string, reason: string | null, now: Date): Promise<'declined' | 'closed'> {
  const p = await lockProposal(tx, ctx, proposalId);
  if (!p) return 'closed';
  if ((p.status !== 'sent' && p.status !== 'viewed') || p.validUntil < today(now)) return 'closed';
  await tx
    .update(proposals)
    .set({ status: 'declined', declinedAt: now, declineReason: reason, updatedAt: now })
    .where(and(eq(proposals.companyId, ctx.companyId), eq(proposals.id, proposalId)));
  await tx.insert(proposalEvents).values({
    companyId: ctx.companyId,
    proposalId,
    kind: 'declined',
    data: {},
    ipHash: null,
    userAgent: null,
    at: now,
    createdAt: now,
    updatedAt: now,
  });
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: p.jobId,
    kind: 'proposal.declined',
    summary: `The customer declined the proposal (${p.number})`,
    data: { proposalId },
    at: now,
  });
  return 'declined';
}
