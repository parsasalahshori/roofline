/**
 * Enum value lists that only the database layer needs so far. The ones the whole product shares
 * (roles, job stages, task and step statuses, consent sources, activity types, message channels,
 * ...) live in `@roofline/shared`; the ones the API's request schemas validate against moved there
 * in Task 10 and are re-exported below so existing imports from `@roofline/db` keep working.
 */
export {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_SUBJECT_TYPES,
  AD_ACCOUNT_STATUSES,
  AD_CAMPAIGN_STATUSES,
  AD_ERROR_KINDS,
  AD_PLATFORMS,
  APPOINTMENT_KINDS,
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  CALENDAR_CONNECTION_STATUSES,
  CALENDAR_PROVIDERS,
  CALL_STATUSES,
  CLAIM_TAKEN_BY,
  CONFIRMED_VIA,
  CONSENT_REGIMES,
  CONVERSATION_CHANNELS,
  CONVERSATION_OUTCOMES,
  CONVERSATION_STATUSES,
  HANDLED_BY,
  IDENTITY_LEVELS,
  CLAIM_EVENT_ACTORS,
  CLAIM_STATUSES,
  FOLLOW_UP_KINDS,
  COMPANY_STORM_STATUSES,
  DOOR_OUTCOMES,
  DOOR_ROUTE_STATUSES,
  EMAIL_OPT_OUT_SOURCES,
  EXACT_ORDER_STATUSES,
  FOOTPRINT_STATE_STATUSES,
  HAIL_RUN_STATUSES,
  MEASUREMENT_KINDS,
  MEASUREMENT_METHODS,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_PURPOSES,
  PROPOSAL_EVENT_KINDS,
  PROPOSAL_STATUSES,
  QUOTE_STATUSES,
  RECORDING_STATUSES,
  SMS_CONSENT_SOURCES,
  TRANSFER_RESULTS,
  TURN_ROUTES,
  TURN_SPEAKERS,
  STORED_FILE_KINDS,
  STORM_STATUSES,
  TIERS,
  USAGE_KINDS,
  type UsageKind,
} from '@roofline/shared';

/** Roof material of a tier template (spec 4.1). Database-only: the homeowner page shows the tier name. */
export const TIER_MATERIALS = ['architectural', 'premium', 'metal'] as const;

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'disabled'] as const;
export const USER_TOKEN_KINDS = ['verify_email', 'reset_password'] as const;
export const INTEGRATION_STATUSES = ['connected', 'error', 'revoked'] as const;
export const PHONE_NUMBER_PURPOSES = ['main'] as const;
export const TASK_MODES = ['needs_approval', 'live'] as const;
export const AGENT_EVENT_KINDS = [
  'created',
  'approved',
  'partly_approved',
  'declined',
  'step_done',
  'step_failed',
  'step_attention',
  'finished',
  'expired',
] as const;
export const ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export const AGENT_STATUSES_VIEW = ['on', 'paused', 'waiting', 'coming_soon'] as const;
export const EARLY_DELIVERY_STATUSES = ['delivered', 'failed'] as const;
