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
      const base = fill(FEED_COPY.created, { agent, plan: planPhrase(row.taskTitle) });
      return row.customerFirstName ? base + fill(FEED_COPY.createdFor, { firstName: row.customerFirstName }) : base;
    }
    case 'approved': {
      const count = countOf(row.data.approvedSteps);
      return fill(FEED_COPY.approved, {
        actor: row.actorName ?? SOMEONE,
        count,
        steps: count === 1 ? STEP_WORDS.one : STEP_WORDS.many,
      });
    }
    case 'partly_approved': {
      const count = countOf(row.data.approvedSteps);
      const total = countOf(row.data.totalSteps);
      return fill(FEED_COPY.partlyApproved, {
        actor: row.actorName ?? SOMEONE,
        count,
        total,
        steps: total === 1 ? STEP_WORDS.one : STEP_WORDS.many,
      });
    }
    case 'declined':
      return fill(FEED_COPY.declined, { actor: row.actorName ?? SOMEONE });
    case 'step_done':
      return row.stepType === 'send_sms_batch' ? textsSentSentence(row) : fill(FEED_COPY.stepDone, { agent });
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
