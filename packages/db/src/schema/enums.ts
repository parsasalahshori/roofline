/**
 * Enum value lists that only the database layer needs so far. The ones the whole product shares
 * (roles, job stages, task and step statuses, consent sources, activity types, message channels,
 * ...) live in `@roofline/shared`; the ones the API's request schemas validate against moved there
 * in Task 10 and are re-exported below so existing imports from `@roofline/db` keep working.
 */
export {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_SUBJECT_TYPES,
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
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_PURPOSES,
  QUOTE_STATUSES,
  RECORDING_STATUSES,
  SMS_CONSENT_SOURCES,
  TRANSFER_RESULTS,
  TURN_ROUTES,
  TURN_SPEAKERS,
  USAGE_KINDS,
  type UsageKind,
} from '@roofline/shared';

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'disabled'] as const;
export const USER_TOKEN_KINDS = ['verify_email', 'reset_password'] as const;
export const INTEGRATION_STATUSES = ['connected', 'error', 'revoked'] as const;
export const PHONE_NUMBER_PURPOSES = ['main'] as const;
export const TASK_MODES = ['needs_approval', 'live'] as const;
export const EARLY_DELIVERY_STATUSES = ['delivered', 'failed'] as const;
