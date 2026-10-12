/** Claims, Scheduler and Follow-up agents (G1): shared value lists. */

/** `claims.status` (spec 3.1). */
export const CLAIM_STATUSES = [
  'not_filed',
  'filed',
  'adjuster_scheduled',
  'inspected',
  'approved',
  'partly_approved',
  'denied',
  'supplement_requested',
  'closed',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Who changed a claim's status (`claim_events.by`). */
export const CLAIM_EVENT_ACTORS = ['user', 'agent'] as const;
export type ClaimEventActor = (typeof CLAIM_EVENT_ACTORS)[number];

/** `follow_up_log.kind` (spec 6). */
export const FOLLOW_UP_KINDS = ['proposal', 'lead', 'review', 'claims', 'reminder', 'no_show'] as const;
export type FollowUpKind = (typeof FOLLOW_UP_KINDS)[number];

export * from './follow-up-rules.ts';
export * from './weather-claim-flow.ts';
export * from './claims-guard.ts';
