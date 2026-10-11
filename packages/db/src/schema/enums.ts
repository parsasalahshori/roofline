/**
 * Enum value lists that only the database layer needs so far. The ones the whole product shares
 * (roles, job stages, task and step statuses, ...) live in `@roofline/shared`.
 */
export const MEMBERSHIP_STATUSES = ['invited', 'active', 'disabled'] as const;
export const USER_TOKEN_KINDS = ['verify_email', 'reset_password'] as const;
export const SMS_CONSENT_SOURCES = ['import', 'web_form', 'call', 'text', 'manual'] as const;
export const ACTIVITY_SUBJECT_TYPES = ['customer', 'property', 'job'] as const;
export const ACTIVITY_ACTOR_TYPES = ['user', 'agent', 'system'] as const;
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
export const MESSAGE_CHANNELS = ['sms', 'mms', 'email'] as const;
export const MESSAGE_DIRECTIONS = ['out', 'in'] as const;
export const MESSAGE_PURPOSES = ['marketing', 'informational'] as const;
