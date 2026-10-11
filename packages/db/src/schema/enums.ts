/**
 * Enum value lists that only the database layer needs so far. The ones the whole product shares
 * (roles, job stages, task and step statuses, consent sources, activity types, message channels,
 * ...) live in `@roofline/shared`; the ones the API's request schemas validate against moved there
 * in Task 10 and are re-exported below so existing imports from `@roofline/db` keep working.
 */
export {
  ACTIVITY_ACTOR_TYPES,
  ACTIVITY_SUBJECT_TYPES,
  MESSAGE_CHANNELS,
  MESSAGE_DIRECTIONS,
  MESSAGE_PURPOSES,
  SMS_CONSENT_SOURCES,
} from '@roofline/shared';

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'disabled'] as const;
export const USER_TOKEN_KINDS = ['verify_email', 'reset_password'] as const;
export const INTEGRATION_STATUSES = ['connected', 'error', 'revoked'] as const;
export const USAGE_KINDS = [
  'ai_call_minute',
  'sms_segment',
  'mms',
  'exact_report',
  'texting_registration_fee',
  'phone_number_month',
] as const;
export const PHONE_NUMBER_PURPOSES = ['main'] as const;
export const TASK_MODES = ['needs_approval', 'live'] as const;
