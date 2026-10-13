import type { Agent, StepResult, StepStatus, TaskStatus } from '@roofline/shared';

/*
 * The one place a status or an agent gets its words. Nothing else in the app writes "Working on it"
 * for `running`. The keys are the stored values, which a person never sees.
 */

/** `partly_done` is not here: its words depend on a count, so `taskStatusLabel` makes them. */
export const TASK_STATUS_LABEL: Record<Exclude<TaskStatus, 'partly_done'>, string> = {
  draft: 'Waiting for your OK',
  awaiting_owner: 'Waiting for owner',
  approved: 'Approved',
  declined: 'Not now',
  expired: 'Expired',
  running: 'Working on it',
  done: 'Done',
  needs_attention: 'Needs attention',
};

/** Plain words for a task kind; an unknown kind falls back to its name with underscores as spaces. */
export const TASK_KIND_LABEL: Record<string, string> = {
  storm_plan: 'Storm plan',
  send_storm_plan: 'Storm plan sent',
  send_proposal: 'Proposal sent',
  create_ad_campaign: 'Ad campaign set up',
  order_exact_report: 'Roof measurement ordered',
  send_sms_batch: 'Texts sent',
  send_email_batch: 'Emails sent',
  front_desk_follow_up: 'Follow-up from the front desk',
  exact_report: 'Roof measurement ordered',
  call: 'Phone call',
  text_conversation: 'Text conversation',
  // G1's agents (Claims, Scheduler, Follow-up); same wording as G1's branch.
  claims_nudges: 'Claim check-ins',
  claims_reply_noted: 'Claim reply noted',
  claims_adjuster_visit: 'Adjuster visit booked',
  claim_packet: 'Claim packet',
  reminders: 'Appointment reminders',
  weather_moves: 'Weather moves',
  no_show: 'Missed appointment',
  follow_ups: 'Lead follow-ups',
  stuck_nudges: 'Stuck jobs',
  proposal_call_rep: 'Proposal follow-up call',
};

export const STEP_STATUS_LABEL: Record<StepStatus, string> = {
  pending: 'Ready',
  awaiting_owner: 'Waiting for owner',
  skipped: 'Turned off',
  queued: 'Starting soon',
  running: 'Working on it',
  done: 'Done',
  failed: "Didn't finish — we'll try again",
  needs_attention: 'Needs attention',
};

export const AGENT_LABEL: Record<Agent, string> = {
  storm_scout: 'Storm Scout',
  estimator: 'Estimator',
  front_desk: 'Front Desk',
  claims: 'Claims',
  scheduler: 'Scheduler',
  follow_up: 'Follow-up',
  system: 'Roofline',
};

export function stepStatusLabel(status: StepStatus): string {
  return STEP_STATUS_LABEL[status];
}

// Steps that did not finish. Keyed by status so a new status has to be decided on here.
const STEP_DID_NOT_FINISH: Record<StepStatus, boolean> = {
  pending: false,
  awaiting_owner: false,
  skipped: false,
  queued: false,
  running: false,
  done: false,
  failed: true,
  needs_attention: true,
};

/** A count in a step's result, or 0 for anything that is not a plain, positive number (a nested group of counts, a missing key). */
function count(value: number | Record<string, number> | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How many things the task could not send. The steps say so in their results (`failed`, `blocked`);
 * when none of them does, it is the number of steps that did not finish.
 */
function couldntSend(steps: { status: StepStatus; result: StepResult | null }[]): number {
  const reported = steps.reduce((sum, step) => sum + count(step.result?.failed) + count(step.result?.blocked), 0);
  return reported > 0 ? reported : steps.filter((step) => STEP_DID_NOT_FINISH[step.status]).length;
}

/** Every status but `partly_done`. */
function hasFixedLabel(status: TaskStatus): status is Exclude<TaskStatus, 'partly_done'> {
  return Object.hasOwn(TASK_STATUS_LABEL, status);
}

export function taskStatusLabel(task: {
  status: TaskStatus;
  steps: { status: StepStatus; result: StepResult | null }[];
}): string {
  if (hasFixedLabel(task.status)) return TASK_STATUS_LABEL[task.status];
  // What is left is partly done, the one status that has no fixed words.
  const n = couldntSend(task.steps);
  return n > 0 ? `Mostly done — ${n} couldn't send` : 'Mostly done';
}
