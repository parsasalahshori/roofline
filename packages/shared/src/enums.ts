export const ROLES = ['owner', 'office', 'rep'] as const;
export type Role = (typeof ROLES)[number];

export const CONSENT_STATUSES = ['none', 'express', 'attested', 'written', 'revoked'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const JOB_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed', 'lost'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

export const JOB_SOURCES = ['storm', 'call', 'text', 'web', 'referral', 'import', 'manual'] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

export const CUSTOMER_SOURCES = ['import', 'manual', 'call', 'text', 'web', 'storm'] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number];

export const COMPANY_STATUSES = ['trial', 'trial_ended', 'active', 'past_due', 'canceled'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const CAMPAIGN_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const AGENTS = ['storm_scout', 'estimator', 'front_desk', 'claims', 'scheduler', 'follow_up', 'system'] as const;
export type Agent = (typeof AGENTS)[number];

export const TASK_STATUSES = [
  'draft',
  'awaiting_owner',
  'approved',
  'declined',
  'expired',
  'running',
  'done',
  'partly_done',
  'needs_attention',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'awaiting_owner',
  'skipped',
  'queued',
  'running',
  'done',
  'failed',
  'needs_attention',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const APPROVAL_CLASSES = ['message', 'spend', 'internal'] as const;
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number];

export const MESSAGE_STATUSES = ['scheduled', 'queued', 'sent', 'delivered', 'failed', 'blocked', 'received'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const GATE_RULES = [
  'billing',
  'registration',
  'contact',
  'consent',
  'content',
  'dedupe',
  'frequency',
  'quiet_hours',
] as const;
export type GateRule = (typeof GATE_RULES)[number];

export const SMS_CONSENT_SOURCES = ['import', 'web_form', 'call', 'text', 'manual'] as const;
export type SmsConsentSource = (typeof SMS_CONSENT_SOURCES)[number];

export const ACTIVITY_SUBJECT_TYPES = ['customer', 'property', 'job'] as const;
export type ActivitySubjectType = (typeof ACTIVITY_SUBJECT_TYPES)[number];

export const ACTIVITY_ACTOR_TYPES = ['user', 'agent', 'system'] as const;
export type ActivityActorType = (typeof ACTIVITY_ACTOR_TYPES)[number];

export const MESSAGE_CHANNELS = ['sms', 'mms', 'email'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_DIRECTIONS = ['out', 'in'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const MESSAGE_PURPOSES = ['marketing', 'informational'] as const;
export type MessagePurpose = (typeof MESSAGE_PURPOSES)[number];
