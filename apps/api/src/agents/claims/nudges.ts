import {
  type ClaimCandidate,
  claimNudgeDays,
  agentCompanyFacts,
  followUpLogFor,
  g1AgentOn,
  hasAgentTaskBetween,
  lastInboundAt,
  lastStormTextAt,
  listClaimNudgeCandidates,
  type TenantContext,
  type Tx,
  withTenant,
  zoneDayAfter,
  zoneDayStart,
} from '@roofline/db';
import { type ClaimNudge, claimNudgeDue, followUpAllowed, localDate } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import type { JobMeta } from '../../jobs/queue.ts';
import { type DraftKind, type JobFacts, LlmUnavailableError } from '../../providers/llm.ts';
import { createTask } from '../../tasks/service.ts';
import { draftBodyOk, FROM_TEMPLATE, localTimeToday, systemCtx } from '../common.ts';

/*
 * The Claims agent's daily run (G1 Task 8), fired by the `claims-daily` job at 10 AM local. It finds
 * the claims that are due a check-in (claimNudgeDue), keeps the customers the follow-up limits allow,
 * has Claude write one short text each (or fills in a template), and makes ONE task with a
 * `send_personal_texts` step for the owner to approve. It sends nothing itself, never addresses an
 * insurer or adjuster (only customers are recipients), and never logs a message's text.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back the follow-up log is read: the whole life of a claim (see personal-texts.ts). */
const LOG_WINDOW_DAYS = 365;
/** At most this many customers are texted in one run (the draftTexts limit). */
const MAX_PER_RUN = 25;
/** The plan expires at this hour, company-local, on the day it was made. */
const EXPIRES_HOUR = 18;
/** The longest text the step takes. */
const MAX_BODY = 480;

const KIND_OF = {
  ask_filed: 'claims_ask_filed',
  ask_adjuster_date: 'claims_ask_adjuster_date',
  ask_adjuster_outcome: 'claims_ask_outcome',
} as const satisfies Record<ClaimNudge, DraftKind>;
export type ClaimsDraftKind = (typeof KIND_OF)[ClaimNudge];

// ---------------------------------------------------------------------------------------------
// Templates: plain, short, and they pass the claims guard (no coverage, deductible or insurer-contact words).

type TemplateWho = { first: string; rep: string | null; company: string };

const intro = (w: TemplateWho): string => `Hi ${w.first}, it's ${w.rep !== null ? `${w.rep} at ${w.company}` : w.company}.`;

export const NUDGE_TEMPLATES: Record<ClaimsDraftKind, (w: TemplateWho) => string> = {
  claims_ask_filed: (w) =>
    `${intro(w)} Have you had a chance to file your insurance claim? If so, reply with the claim number and your insurance company.`,
  claims_ask_adjuster_date: (w) =>
    `${intro(w)} Has a date been set for the adjuster visit? If so, reply with the day and time so we can plan around it.`,
  claims_ask_outcome: (w) => `${intro(w)} How did the adjuster visit go? If you have an update on your claim, reply and let us know.`,
};

/** The template text for a kind. */
export function templateFor(kind: ClaimsDraftKind, who: TemplateWho): string {
  return NUDGE_TEMPLATES[kind](who);
}

// ---------------------------------------------------------------------------------------------
// The run

type Planned = { candidate: ClaimCandidate; nudge: ClaimNudge; kind: ClaimsDraftKind };
type Plan = { companyName: string; timeZone: string; day: string; planned: Planned[] };

const wholeDays = (now: Date, from: Date): string => String(Math.max(0, Math.floor((now.getTime() - from.getTime()) / DAY_MS)));

/** What the model is told about one claim: plain strings only. */
function factsFor(p: Planned, companyName: string, now: Date): JobFacts {
  const c = p.candidate;
  const facts: Record<string, string> = {};
  if (p.nudge === 'ask_filed' && c.inspectedAt) facts.daysSinceInspection = wholeDays(now, c.inspectedAt);
  if (p.nudge === 'ask_adjuster_date') facts.daysSinceFiled = wholeDays(now, c.statusChangedAt);
  if (p.nudge === 'ask_adjuster_outcome' && c.adjusterAt) facts.daysSinceAdjusterVisit = wholeDays(now, c.adjusterAt);
  return { jobId: c.jobId, customerFirstName: c.customerFirstName, companyName, repFirstName: c.repFirstName, address: c.address, facts };
}

const dayBounds = (day: string, timeZone: string): [Date, Date] => [zoneDayStart(day, timeZone), zoneDayStart(zoneDayAfter(day), timeZone)];

/** Steps 1 to 6: who is due a check-in today, or null when the agent should do nothing. */
async function planRun(tx: Tx, ctx: TenantContext, now: Date): Promise<Plan | null> {
  const company = await agentCompanyFacts(tx, ctx);
  if (company === null || (company.status !== 'active' && company.status !== 'trial')) return null;
  if (!(await g1AgentOn(tx, ctx, 'claims'))) return null;

  const day = localDate(now, company.timeZone);
  const [dayStart, dayEnd] = dayBounds(day, company.timeZone);
  if (await hasAgentTaskBetween(tx, ctx, { agent: 'claims', kind: 'claims_nudges', from: dayStart, to: dayEnd })) return null;

  const days = await claimNudgeDays(tx, ctx);
  const due: Planned[] = [];
  for (const candidate of await listClaimNudgeCandidates(tx, ctx)) {
    const nudge = claimNudgeDue(
      { status: candidate.status, inspectedAt: candidate.inspectedAt, statusChangedAt: candidate.statusChangedAt, adjusterAt: candidate.adjusterAt },
      now,
      days,
    );
    if (nudge !== null) due.push({ candidate, nudge, kind: KIND_OF[nudge] });
  }
  if (due.length === 0) return null;

  const customerIds = [...new Set(due.map((p) => p.candidate.customerId))];
  const log = await followUpLogFor(tx, ctx, customerIds, new Date(now.getTime() - LOG_WINDOW_DAYS * DAY_MS));
  const planned: Planned[] = [];
  const seen = new Set<string>();
  for (const p of due) {
    const c = p.candidate;
    if (seen.has(c.customerId)) continue; // one text per customer per run
    const decision = followUpAllowed({
      log,
      kind: 'claims',
      customerId: c.customerId,
      jobId: c.jobId,
      now,
      lastInboundAt: await lastInboundAt(tx, ctx, c.customerId),
      lastStormTextAt: await lastStormTextAt(tx, ctx, c.customerId),
    });
    if (!decision.allowed) continue;
    seen.add(c.customerId);
    planned.push(p);
    if (planned.length >= MAX_PER_RUN) break; // the candidates are already oldest claim first
  }
  if (planned.length === 0) return null;
  return { companyName: company.name, timeZone: company.timeZone, day, planned };
}

/** Step 7: one text per planned claim, from the model where it passes the guards, else from the template. */
async function writeTexts(deps: AppDeps, plan: Plan, now: Date): Promise<{ bodies: Map<string, string>; fromTemplate: boolean }> {
  const bodies = new Map<string, string>(); // jobId -> body
  let fromTemplate = false;

  const kinds = [...new Set(plan.planned.map((p) => p.kind))];
  for (const kind of kinds) {
    const group = plan.planned.filter((p) => p.kind === kind);
    let drafted = new Map<string, string>();
    try {
      const result = await deps.llm.draftTexts({ instruction: kind, facts: group.map((p) => factsFor(p, plan.companyName, now)) });
      drafted = new Map(result.texts.map((t) => [t.jobId, t.body]));
    } catch (err) {
      if (!(err instanceof LlmUnavailableError)) throw err;
    }
    for (const p of group) {
      const body = drafted.get(p.candidate.jobId);
      if (body !== undefined && draftBodyOk(body, { repName: p.candidate.repFirstName, maxChars: MAX_BODY })) {
        bodies.set(p.candidate.jobId, body.trim());
      } else {
        fromTemplate = true;
        bodies.set(
          p.candidate.jobId,
          templateFor(kind, { first: p.candidate.customerFirstName, rep: p.candidate.repFirstName, company: plan.companyName }),
        );
      }
    }
  }
  return { bodies, fromTemplate };
}

/** The daily run: see the comment at the top of the file. */
export async function runClaimsDaily(deps: AppDeps, companyId: string, meta: JobMeta): Promise<void> {
  void meta;
  const ctx = systemCtx(companyId);
  const now = deps.clock.now();

  const plan = await withTenant(deps.pools, ctx, (tx) => planRun(tx, ctx, now));
  if (plan === null) return;

  // The model is called outside any transaction.
  const { bodies, fromTemplate } = await writeTexts(deps, plan, now);
  const messages = plan.planned.map((p) => ({ customerId: p.candidate.customerId, jobId: p.candidate.jobId, body: bodies.get(p.candidate.jobId)! }));
  const [dayStart, dayEnd] = dayBounds(plan.day, plan.timeZone);

  await withTenant(deps.pools, ctx, async (tx) => {
    // Another run may have made today's plan while the model was writing: one plan a day.
    if (await hasAgentTaskBetween(tx, ctx, { agent: 'claims', kind: 'claims_nudges', from: dayStart, to: dayEnd })) return;
    await createTask(
      tx,
      ctx,
      {
        agent: 'claims',
        kind: 'claims_nudges',
        title: `Claim check-ins (${messages.length} texts)`,
        summary: fromTemplate
          ? `${FROM_TEMPLATE}. Asks homeowners where their insurance claim stands.`
          : 'Asks homeowners where their insurance claim stands.',
        expiresAt: localTimeToday(plan.day, EXPIRES_HOUR, plan.timeZone),
        steps: [
          {
            type: 'send_personal_texts',
            payload: { purpose: 'informational', kind: 'claims', messages, dedupePrefix: `claims:${plan.day}` },
          },
        ],
      },
      { now, allowInternalStepTypes: true },
    );
  });
}
