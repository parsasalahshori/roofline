import type { FeedRow } from '@roofline/db';
import type { Agent } from '@roofline/shared';

/*
 * Plain sentences for the agents feed and the waiting list. Every word a reader sees about an
 * agent's work comes from here (copy constants, not inline strings). Rows carry counts and ids
 * only; this text never includes message text, and it never stores what it builds.
 */

/** The name each agent goes by on the screen. */
export const AGENT_NAMES: Record<Agent, string> = {
  storm_scout: 'Storm Scout',
  estimator: 'Estimator',
  front_desk: 'Front Desk',
  claims: 'Claims',
  scheduler: 'Scheduler',
  follow_up: 'Follow-up',
  system: 'Roofline',
};

/** Used when the person who acted is not known to the reader. */
export const SOMEONE = 'Someone';

/** Sentences per feed kind. `{x}` marks a value filled in at read time. */
export const FEED_COPY = {
  created: '{agent} drafted {plan}',
  createdFor: ' for {firstName}',
  approved: '{actor} approved {count} {steps}',
  partlyApproved: '{actor} approved {count} of {total} {steps}',
  declined: '{actor} declined the plan',
  declinedStep: '{actor} declined a step',
  approvedNone: '{actor} approved the plan with every step switched off',
  sentToOwner: '{actor} sent {count} {steps} to the owner',
  reran: '{actor} re-ran {title}',
  stepCount: '{label}: {count} {verb}',
  textsSent: 'Texts: {count} sent',
  textsSentPlain: 'Texts sent',
  stepDone: '{agent}: a step finished',
  stepFailed: '{agent}: a step could not finish',
  stepAttention: '{agent}: a step needs a look',
  finishedDone: 'Finished: {title}',
  finishedPartly: 'Partly finished: {title}',
  finishedFailed: 'Could not finish: {title}',
  finishedOther: 'Finished: {title}',
  expired: 'A draft expired without an answer: {title}',
  waitingDraft: '{agent} has a draft waiting: {title}',
  waitingAttention: '{agent} needs help: {title}',
  waitingReason: '{sentence}. {reason}',
  fallback: '{agent} has an update: {title}',
} as const;

/** Words for the step count: "1 step", "3 steps". */
export const STEP_WORDS = { one: 'step', many: 'steps' } as const;

/** Plural-label and verb per step type for a finished step's unit count (E-M6). */
const STEP_UNIT_WORDS: Record<string, { label: string; verb: string }> = {
  send_email_batch: { label: 'Emails', verb: 'sent' },
  build_routes: { label: 'Routes', verb: 'built' },
  create_ad_campaign: { label: 'Campaigns', verb: 'created' },
  send_proposal: { label: 'Proposals', verb: 'sent' },
};

/** Prefix for a created plan whose title does not already read as "a/an ...". */
const PLAN_PREFIX = 'a plan: ';
const ARTICLE = /^(a|an) /i;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''));
}

/** A count read from stored counts: a finite number, else 0. */
function countOf(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function planPhrase(title: string): string {
  return ARTICLE.test(title) ? title : `${PLAN_PREFIX}${title}`;
}

/** Texts sent by a send_sms_batch step, from its stored result; plain when the count is missing. */
function textsSentSentence(row: FeedRow): string {
  const result = row.stepResult ?? {};
  if (result.sent === undefined && result.sentCount === undefined) return FEED_COPY.textsSentPlain;
  return fill(FEED_COPY.textsSent, { count: countOf(result.sent ?? result.sentCount) });
}

function finishedSentence(row: FeedRow): string {
  switch (row.data.status) {
    case 'done':
      return fill(FEED_COPY.finishedDone, { title: row.taskTitle });
    case 'partly_done':
      return fill(FEED_COPY.finishedPartly, { title: row.taskTitle });
    case 'failed':
      return fill(FEED_COPY.finishedFailed, { title: row.taskTitle });
    default:
      return fill(FEED_COPY.finishedOther, { title: row.taskTitle });
  }
}

/** Plain sentence for one feed row. Never includes message text. */
export function feedSentence(row: FeedRow): string {
  const agent = AGENT_NAMES[row.agent];
  switch (row.kind) {
    case 'created': {
      // A person (not an agent) creates a task only by re-running an expired plan.
      if (row.actorName !== null) return fill(FEED_COPY.reran, { actor: row.actorName, title: row.taskTitle });
      const base = fill(FEED_COPY.created, { agent, plan: planPhrase(row.taskTitle) });
      return row.customerFirstName ? base + fill(FEED_COPY.createdFor, { firstName: row.customerFirstName }) : base;
    }
    case 'approved': {
      const count = countOf(row.data.approvedSteps);
      if (count === 0) return fill(FEED_COPY.approvedNone, { actor: row.actorName ?? SOMEONE });
      return fill(FEED_COPY.approved, {
        actor: row.actorName ?? SOMEONE,
        count,
        steps: count === 1 ? STEP_WORDS.one : STEP_WORDS.many,
      });
    }
    case 'partly_approved': {
      const count = countOf(row.data.approvedSteps);
      const total = countOf(row.data.totalSteps);
      // forwardedSteps is the count of steps moved to awaiting_owner; total - approved is kept only as a
      // fallback for events written before it existed.
      const forwarded =
        row.data.forwardedSteps !== undefined ? Math.max(1, countOf(row.data.forwardedSteps)) : Math.max(1, total - count);
      return fill(FEED_COPY.sentToOwner, {
        actor: row.actorName ?? SOMEONE,
        count: forwarded,
        steps: forwarded === 1 ? STEP_WORDS.one : STEP_WORDS.many,
      });
    }
    case 'declined':
      if (row.stepType !== null) return fill(FEED_COPY.declinedStep, { actor: row.actorName ?? SOMEONE });
      return fill(FEED_COPY.declined, { actor: row.actorName ?? SOMEONE });
    case 'step_done': {
      if (row.stepType === 'send_sms_batch') return textsSentSentence(row);
      const words = row.stepType !== null ? STEP_UNIT_WORDS[row.stepType] : undefined;
      if (words && row.data.units !== undefined) {
        return fill(FEED_COPY.stepCount, { ...words, count: countOf(row.data.units) });
      }
      return fill(FEED_COPY.stepDone, { agent });
    }
    case 'step_failed':
      return fill(FEED_COPY.stepFailed, { agent });
    case 'step_attention':
      return fill(FEED_COPY.stepAttention, { agent });
    case 'finished':
      return finishedSentence(row);
    case 'expired':
      return fill(FEED_COPY.expired, { title: row.taskTitle });
    default:
      return fill(FEED_COPY.fallback, { agent, title: row.taskTitle });
  }
}

/** Sentence for a draft waiting for approval, e.g. "Storm Scout has a draft waiting: <title>". */
export function waitingDraftText(agent: Agent, title: string): string {
  return fill(FEED_COPY.waitingDraft, { agent: AGENT_NAMES[agent], title });
}

/** Sentence for a task that needs attention; `reason` is the plain error text or null. */
export function waitingAttentionText(agent: Agent, title: string, reason: string | null): string {
  const sentence = fill(FEED_COPY.waitingAttention, { agent: AGENT_NAMES[agent], title });
  return reason ? fill(FEED_COPY.waitingReason, { sentence, reason }) : sentence;
}
