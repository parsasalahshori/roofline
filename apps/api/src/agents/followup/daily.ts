import { and, eq, gte } from 'drizzle-orm';
import {
  agentTasks,
  companies,
  companySettings,
  findLeadCandidates,
  findStuckCandidates,
  followUpLogFor,
  findProposalCandidates,
  getJob,
  PROPOSAL_CALL_KIND,
  PROPOSAL_CALL_SUBJECT,
  followUpSettings,
  lastInboundAt,
  lastStormTextAt,
  memberNames,
  recordStuckNudge,
  STUCK_NUDGE_GAP_DAYS,
  type StuckCandidate,
  type TenantContext,
  busyFor,
  getAgentSettings,
  memberHours,
  updateJob,
  type Tx,
  withTenant,
  zoneDayStart,
} from '@roofline/db';
import { DEFAULT_WORK_HOURS, followUpAllowed, NEXT_STEP_MAX, type WorkHours } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { createTask } from '../../tasks/service.ts';
import { writeAgentNote } from '../notes.ts';
import { localParts } from '../schedule.ts';
import { draftLeadTexts, draftProposalTexts, type LeadDraftInput, pickTwoSlots, type ProposalDraftInput } from './draft.ts';

/*
 * The Follow-up agent's daily run (G1 Task 13a), 9 AM company-local. Two independent parts, each
 * made at most once per company-local day:
 * - leads: unbooked leads get a text offering two inspection times. One plan for the owner to approve.
 * - stuck jobs: the rep gets a next step on the job. No customer text, no email; one live task
 *   (no approval) records it.
 * Nothing here logs message text or names.
 */

const AGENT = 'follow_up';
const LEADS_KIND = 'follow_ups';
const STUCK_KIND = 'stuck_nudges';
const LEAD_CAP = 25;
const PROPOSAL_CAP = 25;
const DEFAULT_FOLLOWUP_DAYS = [3, 4];
const DAY_MS = 86_400_000;
const LOG_WINDOW_DAYS = 365;
const PLAN_EXPIRES_HOUR = 18;

const systemCtx = (companyId: string): TenantContext => ({ companyId, userId: null, role: 'system', canApproveSpend: false });

/**
 * Whether the Follow-up agent is on for the company. Ruling GX-E: until Task 15 wires pause, a
 * missing agent_settings row means off. Task 15 replaces this one helper.
 */
async function followUpAgentOn(tx: Tx, ctx: TenantContext): Promise<boolean> {
  const row = await getAgentSettings(tx, ctx, AGENT);
  return row !== null && row.pausedAt === null;
}

/** True when the agent already made a task of this kind on the company-local day that starts at `dayStart`. */
async function madeToday(tx: Tx, ctx: TenantContext, kind: string, dayStart: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: agentTasks.id })
    .from(agentTasks)
    .where(
      and(eq(agentTasks.companyId, ctx.companyId), eq(agentTasks.agent, AGENT), eq(agentTasks.kind, kind), gte(agentTasks.createdAt, dayStart)),
    )
    .limit(1);
  return row !== undefined;
}

/** 6 PM company-local on the given day. */
function sixPm(day: string, timeZone: string): Date {
  let t = zoneDayStart(day, timeZone).getTime() + PLAN_EXPIRES_HOUR * 3_600_000;
  // A day with a clock change is not 24 hours long; move to the wall-clock hour.
  const hour = localParts(new Date(t), timeZone).hour;
  t += (PLAN_EXPIRES_HOUR - hour) * 3_600_000;
  return new Date(t);
}

const firstWord = (name: string | undefined): string | null => name?.trim().split(/\s+/)[0] || null;

export async function runFollowUps(deps: AppDeps, companyId: string, meta: JobMeta): Promise<void> {
  void meta;
  const now = deps.clock.now();
  const ctx = systemCtx(companyId);

  // 1-2: the company and the agent.
  const company = await withTenant(deps.pools, ctx, async (tx) => {
    const [row] = await tx
      .select({ status: companies.status, timeZone: companies.timezone, name: companies.name, workHours: companySettings.workHours })
      .from(companies)
      .leftJoin(companySettings, eq(companySettings.companyId, companies.id))
      .where(eq(companies.id, companyId))
      .limit(1);
    if (!row || (row.status !== 'active' && row.status !== 'trial')) return null;
    if (!(await followUpAgentOn(tx, ctx))) return null;
    return { timeZone: row.timeZone, name: row.name, workHours: (row.workHours ?? DEFAULT_WORK_HOURS) as WorkHours };
  });
  if (company === null) return;

  const today = localParts(now, company.timeZone).localDate;
  const dayStart = zoneDayStart(today, company.timeZone);

  await runTexts(deps, ctx, company, now, today, dayStart);
  await runStuck(deps, ctx, company.timeZone, now, today, dayStart);
}

type Company = { timeZone: string; name: string; workHours: WorkHours };

type Prepared = { leads: LeadDraftInput[]; proposals: ProposalDraftInput[] };

async function runTexts(deps: AppDeps, ctx: TenantContext, company: Company, now: Date, today: string, dayStart: Date): Promise<void> {
  // The candidates and everything the drafts need, read in one transaction.
  const prepared = await withTenant(deps.pools, ctx, async (tx): Promise<Prepared | null> => {
    const settings = await followUpSettings(tx, ctx);
    const [proposalRow] = await tx
      .select({ followupProposals: companySettings.followupProposals, followupDays: companySettings.followupDays })
      .from(companySettings)
      .where(eq(companySettings.companyId, ctx.companyId))
      .limit(1);
    const proposalsOn = proposalRow?.followupProposals ?? true;
    const followupDays = proposalRow?.followupDays ?? DEFAULT_FOLLOWUP_DAYS;
    if (!settings.followupLeads && !proposalsOn) return null;
    const made = await madeToday(tx, ctx, LEADS_KIND, dayStart);

    const leadCandidates =
      settings.followupLeads && !made ? await findLeadCandidates(tx, ctx, now, { leadFollowupDays: settings.leadFollowupDays }) : [];
    const proposalCandidates = proposalsOn ? await findProposalCandidates(tx, ctx, now, { followupDays }) : [];
    const names =
      leadCandidates.length > 0 || proposalCandidates.length > 0 ? await memberNames(tx) : new Map<string, string>();
    // G1 Task 13a: each lead's times come from its rep's own hours and busy time (company hours if unassigned).
    const repIds = [...new Set(leadCandidates.map((c) => c.assignedUserId).filter((id): id is string => id !== null))];
    const busy = await busyFor(tx, ctx, repIds, now, new Date(now.getTime() + 5 * DAY_MS));
    const hoursByRep = new Map<string, WorkHours>();
    for (const id of repIds) hoursByRep.set(id, (await memberHours(tx, ctx, id)).workHours);

    const logSince = new Date(now.getTime() - LOG_WINDOW_DAYS * DAY_MS);
    const leads: LeadDraftInput[] = [];
    for (const c of leadCandidates) {
      if (leads.length >= LEAD_CAP) break;
      const decision = followUpAllowed({
        log: await followUpLogFor(tx, ctx, [c.customerId], logSince),
        kind: 'lead',
        customerId: c.customerId,
        jobId: c.jobId,
        now,
        lastInboundAt: await lastInboundAt(tx, ctx, c.customerId),
        lastStormTextAt: await lastStormTextAt(tx, ctx, c.customerId),
      });
      if (!decision.allowed) continue;
      const slots = pickTwoSlots({
        workHours: c.assignedUserId === null ? company.workHours : (hoursByRep.get(c.assignedUserId) ?? company.workHours),
        busy: c.assignedUserId === null ? [] : (busy.get(c.assignedUserId) ?? []),
        propertyId: c.propertyId,
        timeZone: company.timeZone,
        now,
      });
      if (slots === null) continue;
      leads.push({
        jobId: c.jobId,
        customerId: c.customerId,
        customerFirstName: c.customerFirstName,
        repFirstName: c.assignedUserId === null ? null : firstWord(names.get(c.assignedUserId)),
        address: null,
        slots,
      });
    }

    // G1 Task 13b: unsigned proposals. A customer already getting a lead text today is skipped.
    const leadCustomers = new Set(leads.map((l) => l.customerId));
    const proposals: ProposalDraftInput[] = [];
    for (const c of proposalCandidates) {
      if (c.due === 'call_rep') {
        // No customer text. The rep gets a next step (unless the job has one) and the ask is recorded,
        // so the finder never offers this proposal again. Not blocked by the once-a-day guard.
        const job = await getJob(tx, ctx, c.jobId);
        if (job === null) continue;
        if (job.nextStep === null || job.nextStep.trim() === '') {
          const nextStep = `Call ${c.customerName} about proposal ${c.number}: two texts, no answer.`.slice(0, NEXT_STEP_MAX);
          await updateJob(tx, ctx, c.jobId, { nextStep, nextStepOn: today }, { now });
        }
        await writeAgentNote(
          tx,
          ctx,
          {
            agent: AGENT,
            kind: PROPOSAL_CALL_KIND,
            title: 'Rep asked to call about a proposal',
            label: `Asked the rep to call about proposal ${c.number}`,
            subjectType: PROPOSAL_CALL_SUBJECT,
            subjectId: c.proposalId,
          },
          now,
        );
        continue;
      }
      if (made || proposals.length >= PROPOSAL_CAP) continue;
      if (leadCustomers.has(c.customerId)) continue;
      const decision = followUpAllowed({
        log: await followUpLogFor(tx, ctx, [c.customerId], logSince),
        kind: 'proposal',
        customerId: c.customerId,
        jobId: c.jobId,
        now,
        lastInboundAt: await lastInboundAt(tx, ctx, c.customerId),
        lastStormTextAt: await lastStormTextAt(tx, ctx, c.customerId),
      });
      if (!decision.allowed) continue;
      proposals.push({
        jobId: c.jobId,
        customerId: c.customerId,
        customerFirstName: c.customerFirstName,
        repFirstName: c.assignedUserId === null ? null : firstWord(names.get(c.assignedUserId)),
        proposalNumber: c.number,
        viewed: c.viewed,
        lowestTotalCents: c.lowestTotalCents,
      });
    }
    return { leads, proposals };
  });
  if (prepared === null || (prepared.leads.length === 0 && prepared.proposals.length === 0)) return;

  // The Llm calls are made outside any transaction.
  const leadDraft = prepared.leads.length > 0 ? await draftLeadTexts(deps.llm, company.name, prepared.leads) : null;
  const proposalDraft = prepared.proposals.length > 0 ? await draftProposalTexts(deps.llm, company.name, prepared.proposals) : null;
  const leadTexts = leadDraft?.texts ?? [];
  const proposalTexts = proposalDraft?.texts ?? [];
  const anyTemplate = (leadDraft?.anyTemplate ?? false) || (proposalDraft?.anyTemplate ?? false);
  const jobIds = new Map(prepared.leads.map((l) => [l.customerId, l.jobId]));

  const summaryParts: string[] = [];
  if (anyTemplate) summaryParts.push('Written from a template');
  if (proposalTexts.length > 0) {
    summaryParts.push(proposalTexts.length === 1 ? '1 proposal follow-up' : `${proposalTexts.length} proposal follow-ups`);
  }

  const steps: { type: 'send_personal_texts'; payload: Record<string, unknown> }[] = [];
  if (leadTexts.length > 0) {
    steps.push({
      type: 'send_personal_texts',
      payload: {
        purpose: 'informational',
        kind: 'lead',
        messages: leadTexts.map((t) => ({ customerId: t.customerId, jobId: jobIds.get(t.customerId) ?? t.jobId, body: t.body })),
        dedupePrefix: `followup:${today}`,
      },
    });
  }
  if (proposalTexts.length > 0) {
    steps.push({
      type: 'send_personal_texts',
      payload: {
        purpose: 'informational',
        kind: 'proposal',
        messages: proposalTexts.map((t) => ({ customerId: t.customerId, jobId: t.jobId, body: t.body })),
        dedupePrefix: `followup-proposal:${today}`,
      },
    });
  }

  await withTenant(deps.pools, ctx, async (tx) => {
    // Checked again: a second run may have made the plan while the Llm was writing.
    if (await madeToday(tx, ctx, LEADS_KIND, dayStart)) return;
    await createTask(
      tx,
      ctx,
      {
        agent: AGENT,
        kind: LEADS_KIND,
        title: `Follow-ups for today (${leadTexts.length + proposalTexts.length})`,
        ...(summaryParts.length > 0 && { summary: summaryParts.join('. ') }),
        expiresAt: sixPm(today, company.timeZone),
        createdBy: 'agent',
        steps,
      },
      { now, allowInternalStepTypes: true },
    );
  });
}

async function runStuck(deps: AppDeps, ctx: TenantContext, timeZone: string, now: Date, today: string, dayStart: Date): Promise<void> {
  await withTenant(deps.pools, ctx, async (tx) => {
    if (await madeToday(tx, ctx, STUCK_KIND, dayStart)) return;
    const settings = await followUpSettings(tx, ctx);
    const stuck: StuckCandidate[] = await findStuckCandidates(tx, ctx, now, { timeZone, stuckAfterDays: settings.stuckAfterDays });
    if (stuck.length === 0) return;

    // The jobs are changed first; the task only records that it was done. A job that is gone is not counted.
    let nudged = 0;
    for (const s of stuck) {
      const nextStep = `No activity on the ${s.customerName} job for ${s.days} days.`.slice(0, NEXT_STEP_MAX);
      const saved = await updateJob(tx, ctx, s.jobId, { nextStep, nextStepOn: today }, { now });
      if (saved === null) continue;
      await recordStuckNudge(tx, ctx, s.jobId, s.days, now);
      nudged += 1;
    }
    if (nudged === 0) return;

    // A live note (Ruling GX-R): no approval, nothing sent.
    await writeAgentNote(
      tx,
      ctx,
      {
        agent: AGENT,
        kind: STUCK_KIND,
        title: `Nudged reps about ${nudged} quiet jobs`,
        label: `Reminded reps about ${nudged} quiet jobs (every ${STUCK_NUDGE_GAP_DAYS} days at most)`,
      },
      now,
    );
  });
}
