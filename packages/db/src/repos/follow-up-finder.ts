import { and, asc, eq, inArray, isNotNull, isNull, lte, max, ne, notExists, or, sql } from 'drizzle-orm';
import { daysInStage, isStuck, leadFollowUpDue, proposalFollowUpDue, REPLY_STOP_DAYS } from '@roofline/shared';
import {
  activities,
  agentTasks,
  appointments,
  companySettings,
  type CustomerPhone,
  customers,
  followUpLog,
  jobs,
  messages,
  proposalOptions,
  proposals,
} from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';
import { addActivity } from './activities.ts';

/*
 * The Follow-up agent's finder (G1 Task 13a): which unbooked leads are due a text, which stuck jobs
 * are due a rep nudge. Everything runs inside the caller's `withTenant` transaction and names the
 * company in every query. Nothing here reads or logs message text.
 */

export type LeadCandidate = {
  jobId: string;
  customerId: string;
  customerFirstName: string | null;
  propertyId: string;
  assignedUserId: string | null;
  createdAt: Date;
};

export type StuckCandidate = { jobId: string; customerId: string; customerName: string; assignedUserId: string; days: number };

export const STUCK_NUDGE_ACTIVITY = 'followup.stuck_nudge';
/** A job is nudged at most once in this many days. */
export const STUCK_NUDGE_GAP_DAYS = 7;

const DAY_MS = 86_400_000;
const DEFAULT_LEAD_FOLLOWUP_DAYS = 2;
const DEFAULT_STUCK_AFTER_DAYS = 14;

function textingPhone(phones: readonly CustomerPhone[]): CustomerPhone | null {
  const usable = phones.filter((p) => typeof p?.e164 === 'string' && p.e164.trim() !== '');
  return usable.find((p) => p.primary === true) ?? usable[0] ?? null;
}

/** Leads that are due a follow-up text. */
export async function findLeadCandidates(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  opts: { leadFollowupDays: number },
): Promise<LeadCandidate[]> {
  const cutoff = new Date(now.getTime() - opts.leadFollowupDays * DAY_MS);
  const rows = await tx
    .select({
      jobId: jobs.id,
      customerId: jobs.customerId,
      customerFirstName: customers.firstName,
      phones: customers.phones,
      propertyId: jobs.propertyId,
      assignedUserId: jobs.assignedUserId,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .where(
      and(
        eq(jobs.companyId, ctx.companyId),
        eq(jobs.stage, 'lead'),
        isNull(jobs.archivedAt),
        lte(jobs.createdAt, cutoff),
        isNull(customers.archivedAt),
        eq(customers.doNotContact, false),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(appointments)
            .where(
              and(
                eq(appointments.companyId, ctx.companyId),
                eq(appointments.jobId, jobs.id),
                inArray(appointments.status, ['scheduled', 'completed']),
                isNull(appointments.archivedAt),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(jobs.createdAt), asc(jobs.id));

  // The number the send gate will text (primary, else first) must exist and not be labelled landline.
  const textable = rows.filter((r) => {
    const p = textingPhone(r.phones ?? []);
    return p !== null && (p.label ?? '').trim().toLowerCase() !== 'landline';
  });
  if (textable.length === 0) return [];

  const jobIds = textable.map((r) => r.jobId);
  const customerIds = [...new Set(textable.map((r) => r.customerId))];

  const sentRows = await tx
    .select({ jobId: followUpLog.jobId })
    .from(followUpLog)
    .where(and(eq(followUpLog.companyId, ctx.companyId), eq(followUpLog.kind, 'lead'), inArray(followUpLog.jobId, jobIds)));
  const textsSent = new Map<string, number>();
  for (const r of sentRows) if (r.jobId !== null) textsSent.set(r.jobId, (textsSent.get(r.jobId) ?? 0) + 1);

  const inboundRows = await tx
    .select({ customerId: messages.customerId, at: max(messages.createdAt) })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.direction, 'in'), inArray(messages.customerId, customerIds)))
    .groupBy(messages.customerId);
  const lastInbound = new Map<string, Date>();
  for (const r of inboundRows) if (r.customerId !== null && r.at !== null) lastInbound.set(r.customerId, r.at);

  const seen = new Set<string>();
  const out: LeadCandidate[] = [];
  for (const r of textable) {
    if (seen.has(r.customerId)) continue; // one lead per customer: the oldest job
    const due = leadFollowUpDue(
      { createdAt: r.createdAt, hasAppointment: false, textsSent: textsSent.get(r.jobId) ?? 0, lost: false },
      now,
      opts.leadFollowupDays,
    );
    if (!due) continue;
    const inboundAt = lastInbound.get(r.customerId);
    if (inboundAt !== undefined && now.getTime() - inboundAt.getTime() < REPLY_STOP_DAYS * DAY_MS) continue;
    seen.add(r.customerId);
    out.push({
      jobId: r.jobId,
      customerId: r.customerId,
      customerFirstName: r.customerFirstName,
      propertyId: r.propertyId,
      assignedUserId: r.assignedUserId,
      createdAt: r.createdAt,
    });
  }
  return out;
}

/** Stuck jobs with a rep, not nudged in the last 7 days, with no next step of their own. */
export async function findStuckCandidates(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  opts: { timeZone: string; stuckAfterDays: number },
): Promise<StuckCandidate[]> {
  const rows = await tx
    .select({
      jobId: jobs.id,
      customerId: jobs.customerId,
      customerName: customers.displayName,
      stage: jobs.stage,
      assignedUserId: jobs.assignedUserId,
      stageChangedAt: jobs.stageChangedAt,
    })
    .from(jobs)
    .innerJoin(customers, and(eq(customers.companyId, jobs.companyId), eq(customers.id, jobs.customerId)))
    .where(
      and(
        eq(jobs.companyId, ctx.companyId),
        isNull(jobs.archivedAt),
        sql`${jobs.assignedUserId} is not null`,
        or(isNull(jobs.nextStep), eq(jobs.nextStep, '')),
      ),
    )
    .orderBy(asc(jobs.stageChangedAt), asc(jobs.id));

  const stuck: StuckCandidate[] = [];
  for (const r of rows) {
    if (r.assignedUserId === null) continue;
    const days = daysInStage(r.stageChangedAt, now, opts.timeZone);
    if (!isStuck(r.stage, days, opts.stuckAfterDays)) continue;
    stuck.push({ jobId: r.jobId, customerId: r.customerId, customerName: r.customerName, assignedUserId: r.assignedUserId, days });
  }
  if (stuck.length === 0) return [];

  const since = new Date(now.getTime() - STUCK_NUDGE_GAP_DAYS * DAY_MS);
  const recent = await tx
    .select({ subjectId: activities.subjectId })
    .from(activities)
    .where(
      and(
        eq(activities.companyId, ctx.companyId),
        eq(activities.subjectType, 'job'),
        eq(activities.kind, STUCK_NUDGE_ACTIVITY),
        inArray(
          activities.subjectId,
          stuck.map((s) => s.jobId),
        ),
        sql`${activities.at} >= ${since}`,
      ),
    );
  const nudged = new Set(recent.map((r) => r.subjectId));
  return stuck.filter((s) => !nudged.has(s.jobId));
}

/** The company's follow-up settings, with the column defaults when there is no row. */
export async function followUpSettings(
  tx: Tx,
  ctx: TenantContext,
): Promise<{ leadFollowupDays: number; followupLeads: boolean; stuckAfterDays: number }> {
  const [row] = await tx
    .select({
      leadFollowupDays: companySettings.leadFollowupDays,
      followupLeads: companySettings.followupLeads,
      stuckAfterDays: companySettings.stuckAfterDays,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, ctx.companyId))
    .limit(1);
  return {
    leadFollowupDays: row?.leadFollowupDays ?? DEFAULT_LEAD_FOLLOWUP_DAYS,
    followupLeads: row?.followupLeads ?? true,
    stuckAfterDays: row?.stuckAfterDays ?? DEFAULT_STUCK_AFTER_DAYS,
  };
}

/** Records that the rep was reminded about a quiet job (the 7-day gap reads this). */
export async function recordStuckNudge(tx: Tx, ctx: TenantContext, jobId: string, days: number, now: Date): Promise<void> {
  await addActivity(tx, ctx, {
    subjectType: 'job',
    subjectId: jobId,
    kind: STUCK_NUDGE_ACTIVITY,
    summary: 'Reminded the rep about a quiet job',
    data: { days },
    at: now,
    actorAgent: 'follow_up',
  });
}

/** G1 Task 13b: an unsigned proposal that is due a follow-up. `due` comes from `proposalFollowUpDue`. */
export type ProposalCandidate = {
  proposalId: string;
  number: string;
  jobId: string;
  customerId: string;
  customerFirstName: string | null;
  customerName: string;
  assignedUserId: string | null;
  viewed: boolean;
  /** The lowest enabled option total in cents, or null when the proposal has no options. */
  lowestTotalCents: number | null;
  due: 'text' | 'call_rep';
};

/** The subject type and task kind of the live note that records "the rep was asked to call" (Task 13b). */
export const PROPOSAL_CALL_SUBJECT = 'proposal';
export const PROPOSAL_CALL_KIND = 'proposal_call_rep';

/** Unsigned proposals due a text or a rep call. Nothing here reads message text. */
export async function findProposalCandidates(
  tx: Tx,
  ctx: TenantContext,
  now: Date,
  opts: { followupDays: readonly number[] },
): Promise<ProposalCandidate[]> {
  const rows = await tx
    .select({
      proposalId: proposals.id,
      number: proposals.number,
      status: proposals.status,
      jobId: proposals.jobId,
      customerId: proposals.customerId,
      sentAt: proposals.sentAt,
      lastViewedAt: proposals.lastViewedAt,
      signedAt: proposals.signedAt,
      customerFirstName: customers.firstName,
      customerName: customers.displayName,
      phones: customers.phones,
      assignedUserId: jobs.assignedUserId,
    })
    .from(proposals)
    .innerJoin(customers, and(eq(customers.companyId, proposals.companyId), eq(customers.id, proposals.customerId)))
    .innerJoin(jobs, and(eq(jobs.companyId, proposals.companyId), eq(jobs.id, proposals.jobId)))
    .where(
      and(
        eq(proposals.companyId, ctx.companyId),
        inArray(proposals.status, ['sent', 'viewed']),
        isNotNull(proposals.sentAt),
        isNull(proposals.signedAt),
        ne(jobs.stage, 'lost'),
        isNull(jobs.archivedAt),
        isNull(customers.archivedAt),
        eq(customers.doNotContact, false),
      ),
    )
    .orderBy(asc(proposals.sentAt), asc(proposals.id));

  const textable = rows.filter((r) => {
    const p = textingPhone(r.phones ?? []);
    return p !== null && (p.label ?? '').trim().toLowerCase() !== 'landline';
  });
  if (textable.length === 0) return [];

  const jobIds = [...new Set(textable.map((r) => r.jobId))];
  const proposalIds = textable.map((r) => r.proposalId);
  const customerIds = [...new Set(textable.map((r) => r.customerId))];

  const logRows = await tx
    .select({ jobId: followUpLog.jobId, at: followUpLog.at })
    .from(followUpLog)
    .where(and(eq(followUpLog.companyId, ctx.companyId), eq(followUpLog.kind, 'proposal'), inArray(followUpLog.jobId, jobIds)));
  const logByJob = new Map<string, Date[]>();
  for (const r of logRows) {
    if (r.jobId === null) continue;
    const list = logByJob.get(r.jobId) ?? [];
    list.push(r.at);
    logByJob.set(r.jobId, list);
  }

  const callRows = await tx
    .select({ subjectId: agentTasks.subjectId, at: agentTasks.createdAt })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.companyId, ctx.companyId),
        eq(agentTasks.agent, 'follow_up'),
        eq(agentTasks.kind, PROPOSAL_CALL_KIND),
        eq(agentTasks.subjectType, PROPOSAL_CALL_SUBJECT),
        inArray(agentTasks.subjectId, proposalIds),
      ),
    );
  const callRepAt = new Map<string, Date>();
  for (const r of callRows) {
    if (r.subjectId === null) continue;
    const prev = callRepAt.get(r.subjectId);
    if (prev === undefined || r.at.getTime() < prev.getTime()) callRepAt.set(r.subjectId, r.at);
  }

  const inboundRows = await tx
    .select({ customerId: messages.customerId, at: max(messages.createdAt) })
    .from(messages)
    .where(and(eq(messages.companyId, ctx.companyId), eq(messages.direction, 'in'), inArray(messages.customerId, customerIds)))
    .groupBy(messages.customerId);
  const lastInbound = new Map<string, Date>();
  for (const r of inboundRows) if (r.customerId !== null && r.at !== null) lastInbound.set(r.customerId, r.at);

  const optionRows = await tx
    .select({ proposalId: proposalOptions.proposalId, lowest: sql<number | null>`min(${proposalOptions.totalCents})` })
    .from(proposalOptions)
    .where(
      and(
        eq(proposalOptions.companyId, ctx.companyId),
        eq(proposalOptions.enabled, true),
        inArray(proposalOptions.proposalId, proposalIds),
      ),
    )
    .groupBy(proposalOptions.proposalId);
  const lowest = new Map<string, number>();
  for (const r of optionRows) if (r.lowest !== null) lowest.set(r.proposalId, Number(r.lowest));

  const seenText = new Set<string>();
  const out: ProposalCandidate[] = [];
  for (const r of textable) {
    if (r.sentAt === null) continue;
    const sentAtMs = r.sentAt.getTime();
    const sentTexts = (logByJob.get(r.jobId) ?? []).filter((at) => at.getTime() >= sentAtMs);
    const lastTextAt = sentTexts.reduce<Date | null>((m, at) => (m === null || at.getTime() > m.getTime() ? at : m), null);
    const due = proposalFollowUpDue(
      {
        sentAt: r.sentAt,
        lastViewedAt: r.lastViewedAt,
        signedAt: r.signedAt,
        textsSent: sentTexts.length,
        lastTextAt,
        callRepAt: callRepAt.get(r.proposalId) ?? null,
      },
      now,
      opts.followupDays,
    );
    if (due === null) continue;
    const inboundAt = lastInbound.get(r.customerId);
    if (inboundAt !== undefined && now.getTime() - inboundAt.getTime() < REPLY_STOP_DAYS * DAY_MS) continue;
    if (due === 'text') {
      if (seenText.has(r.customerId)) continue; // one text per customer: the oldest proposal
      seenText.add(r.customerId);
    }
    out.push({
      proposalId: r.proposalId,
      number: r.number,
      jobId: r.jobId,
      customerId: r.customerId,
      customerFirstName: r.customerFirstName,
      customerName: r.customerName,
      assignedUserId: r.assignedUserId,
      viewed: r.lastViewedAt !== null || r.status === 'viewed',
      lowestTotalCents: lowest.get(r.proposalId) ?? null,
      due,
    });
  }
  return out;
}
