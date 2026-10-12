/** Front Desk (D1) enum lists. Task 2 adds the guards and rules to this file. */
export const CONVERSATION_CHANNELS = ['voice', 'sms'] as const;
export type ConversationChannel = (typeof CONVERSATION_CHANNELS)[number];
export const CONVERSATION_STATUSES = ['active', 'ended'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const HANDLED_BY = ['assistant', 'team'] as const;
export type HandledBy = (typeof HANDLED_BY)[number];
export const CONVERSATION_OUTCOMES = [
  'booked',
  'confirmed',
  'moved',
  'canceled',
  'job_question',
  'claim',
  'message',
  'transferred',
  'spam',
  'abandoned',
  'other',
] as const;
export type ConversationOutcome = (typeof CONVERSATION_OUTCOMES)[number];
export const IDENTITY_LEVELS = ['unknown', 'matched', 'verified'] as const;
export type IdentityLevel = (typeof IDENTITY_LEVELS)[number];
export const CALL_STATUSES = ['ringing', 'ai', 'ringing_team', 'transferred', 'ended', 'rejected', 'failed'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export const RECORDING_STATUSES = ['none', 'recording', 'stopped_by_caller', 'stored', 'deleted'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];
export const CONSENT_REGIMES = ['all_party', 'one_party'] as const;
export type ConsentRegime = (typeof CONSENT_REGIMES)[number];
export const TRANSFER_RESULTS = ['answered', 'no_answer', 'none'] as const;
export type TransferResult = (typeof TRANSFER_RESULTS)[number];
export const TURN_SPEAKERS = ['caller', 'assistant', 'team', 'system'] as const;
export type TurnSpeaker = (typeof TURN_SPEAKERS)[number];
export const TURN_ROUTES = ['fast', 'opus', 'transfer', 'end'] as const;
export type TurnRoute = (typeof TURN_ROUTES)[number];
export const CONFIRMED_VIA = ['call', 'text', 'manual'] as const;
export type ConfirmedVia = (typeof CONFIRMED_VIA)[number];
export const CLAIM_TAKEN_BY = ['front_desk', 'user'] as const;
export type ClaimTakenBy = (typeof CLAIM_TAKEN_BY)[number];
/** The four voices the owner can pick (two female, two male). */
export const FRONT_DESK_VOICES = [
  { id: 'maya', label: 'Maya' },
  { id: 'claire', label: 'Claire' },
  { id: 'daniel', label: 'Daniel' },
  { id: 'marcus', label: 'Marcus' },
] as const;
export type FrontDeskVoiceId = (typeof FRONT_DESK_VOICES)[number]['id'];
export const DEFAULT_FRONT_DESK_VOICE: FrontDeskVoiceId = 'maya';
