/** G1 follow-up limits and due rules (Task 2a). Pure functions; days are 24-hour periods measured from `now`. */
import type { ClaimStatus, FollowUpKind } from './more-agents.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row of `follow_up_log`, as read for the limit checks. */
export type FollowUpLogEntry = { customerId: string; jobId: string | null; kind: FollowUpKind; n: number; at: Date };

/** Decision 8: one Follow-up text per customer per 3 days, across Follow-up kinds. */
export const FOLLOW_UP_SPACING_DAYS = 3;
/** Decision 8: nothing to a customer with a Storm Scout text in the last 3 days. */
export const STORM_QUIET_DAYS = 3;
/** Decision 7: any inbound text on the customer in the last 3 days stops follow-ups. */
export const REPLY_STOP_DAYS = 3;
/** Spec 3.3: max one claims text per customer per 4 days. */
export const CLAIMS_SPACING_DAYS = 4;
/** Spec 3.3: max 4 claims texts per claim (counted per job). */
export const CLAIMS_MAX_PER_CLAIM = 4;

export type FollowUpCheck = {
  log: readonly FollowUpLogEntry[];
  kind: FollowUpKind;
  customerId: string;
  jobId: string | null;
  now: Date;
  lastInboundAt: Date | null;
  lastStormTextAt: Date | null;
};

export type FollowUpDecision =
  | { allowed: true }
  | { allowed: false; reason: 'replied' | 'storm_text' | 'spacing' | 'claims_spacing' | 'claims_max' };

/** True when `at` is less than `days` 24-hour periods before `now` (exactly `days` ago is not within). */
function withinDays(now: Date, at: Date, days: number): boolean {
  return now.getTime() - at.getTime() < days * DAY_MS;
}

/** True when at least `days` 24-hour periods have passed since `from`. */
function atLeastDays(now: Date, from: Date, days: number | undefined): boolean {
  return days !== undefined && now.getTime() - from.getTime() >= days * DAY_MS;
}

/** Decision 8: every agent text that is not appointment logistics shares one 3-day spacing per customer. */
const NUDGE_KINDS: readonly FollowUpKind[] = ['proposal', 'lead', 'review', 'claims'];

/**
 * Decides whether a follow-up text of `c.kind` may go to the customer now.
 * Reminders and no-show notices are appointment logistics and always allowed.
 * Otherwise the first failing check wins: replied, storm_text, then per kind.
 */
export function followUpAllowed(c: FollowUpCheck): FollowUpDecision {
  if (c.kind === 'reminder' || c.kind === 'no_show') return { allowed: true };

  // Decision 7: any inbound text from the customer stops follow-ups for 3 days.
  if (c.lastInboundAt && withinDays(c.now, c.lastInboundAt, REPLY_STOP_DAYS)) {
    return { allowed: false, reason: 'replied' };
  }
  // Decision 8: a Storm Scout text quiets the customer for 3 days.
  if (c.lastStormTextAt && withinDays(c.now, c.lastStormTextAt, STORM_QUIET_DAYS)) {
    return { allowed: false, reason: 'storm_text' };
  }

  // Decision 8: proposal, lead, review and claims texts share one 3-day spacing per customer (across agents).
  const spaced = c.log.some(
    (e) => e.customerId === c.customerId && NUDGE_KINDS.includes(e.kind) && withinDays(c.now, e.at, FOLLOW_UP_SPACING_DAYS),
  );
  if (spaced) return { allowed: false, reason: 'spacing' };

  if (c.kind === 'claims') {
    const customerClaims = c.log.filter((e) => e.customerId === c.customerId && e.kind === 'claims');
    // Spec 3.3: one claims text per customer per 4 days.
    if (customerClaims.some((e) => withinDays(c.now, e.at, CLAIMS_SPACING_DAYS))) {
      return { allowed: false, reason: 'claims_spacing' };
    }
    // Spec 3.3: at most 4 claims texts per claim (per job).
    if (c.jobId !== null) {
      const perJob = customerClaims.filter((e) => e.jobId === c.jobId).length;
      if (perJob >= CLAIMS_MAX_PER_CLAIM) return { allowed: false, reason: 'claims_max' };
    }
  }

  return { allowed: true };
}

/** Facts about a proposal needed for its follow-up due rule. */
export type ProposalFacts = {
  sentAt: Date;
  lastViewedAt: Date | null;
  signedAt: Date | null;
  textsSent: number;
  lastTextAt: Date | null;
  /** When the rep was asked to call (the C1 next step); after that the proposal is never asked about again. */
  callRepAt: Date | null;
};

/**
 * Next proposal follow-up step, or null. `days` is the company followup_days (default [3, 4]).
 * Signed proposals are never followed up. After two texts the next step is a rep call, asked once
 * (the caller records `callRepAt`, and then this returns null).
 */
export function proposalFollowUpDue(
  p: ProposalFacts,
  now: Date,
  days: readonly number[],
): 'text' | 'call_rep' | null {
  if (p.signedAt !== null || p.callRepAt !== null) return null;
  const first = days[0];
  const second = days[1];

  if (p.textsSent === 0) {
    // First text: after days[0] since sent, or 2 days after the customer's last view.
    if (atLeastDays(now, p.sentAt, first)) return 'text';
    if (p.lastViewedAt && atLeastDays(now, p.lastViewedAt, 2)) return 'text';
    return null;
  }
  if (p.textsSent === 1) {
    // Second text: days[1] after the first text.
    if (p.lastTextAt && atLeastDays(now, p.lastTextAt, second)) return 'text';
    return null;
  }
  // After two texts: the rep is asked to call, once days[1] has passed since the last text.
  if (p.lastTextAt && atLeastDays(now, p.lastTextAt, second)) return 'call_rep';
  return null;
}

/** Facts about a lead needed for its follow-up due rule. */
export type LeadFacts = { createdAt: Date; hasAppointment: boolean; textsSent: number; lost: boolean };

/** A lead gets its first follow-up text once `leadDays` (default 2) have passed, if no appointment and not lost. */
export function leadFollowUpDue(l: LeadFacts, now: Date, leadDays: number): boolean {
  return !l.lost && !l.hasAppointment && l.textsSent === 0 && atLeastDays(now, l.createdAt, leadDays);
}

/** Facts about a claim needed for its nudge due rule. */
export type ClaimFacts = {
  status: ClaimStatus;
  inspectedAt: Date | null;
  statusChangedAt: Date;
  adjusterAt: Date | null;
};

export type ClaimNudge = 'ask_filed' | 'ask_adjuster_date' | 'ask_adjuster_outcome';

/**
 * Which claim nudge is due, or null. `days` is claims_nudge_days (default [3, 5, 7]):
 * days[0] after inspection while not filed, days[1] after filing with no adjuster date,
 * days[2] after the adjuster visit while the outcome is unknown.
 */
export function claimNudgeDue(c: ClaimFacts, now: Date, days: readonly number[]): ClaimNudge | null {
  switch (c.status) {
    case 'not_filed':
      return c.inspectedAt && atLeastDays(now, c.inspectedAt, days[0]) ? 'ask_filed' : null;
    case 'filed':
      return !c.adjusterAt && atLeastDays(now, c.statusChangedAt, days[1]) ? 'ask_adjuster_date' : null;
    case 'adjuster_scheduled':
      return c.adjusterAt && atLeastDays(now, c.adjusterAt, days[2]) ? 'ask_adjuster_outcome' : null;
    default:
      return null;
  }
}
