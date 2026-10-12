import type {
  CallStatus,
  ConversationChannel,
  ConversationOutcome,
  ConversationStatus,
  FrontDeskVoiceId,
  HandledBy,
  IdentityLevel,
  RecordingStatus,
  TransferResult,
  TurnSpeaker,
} from './front-desk.ts';

/*
 * Front Desk API views (Ruling DR): the JSON shapes the D1 routes (Task 18, Task 17's forwarding test,
 * Task 12's recording link) return and the web (Tasks 21-24, 26) reads. Routes build exactly these;
 * the web's hooks in features/front-desk/api.ts type their responses with them. Times are ISO strings.
 */

/** The inbox filters on GET /api/conversations?filter= (spec §13). */
export const CONVERSATION_FILTERS = ['all', 'needs_attention', 'booked', 'messages', 'spam'] as const;
export type ConversationFilter = (typeof CONVERSATION_FILTERS)[number];

/** One row of the Front Desk window's list. `name` is the customer's name, or null for an unknown number. */
export type ConversationListItem = {
  id: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  customerId: string | null;
  name: string | null;
  phoneE164: string;
  outcome: ConversationOutcome | null;
  summary: string | null;
  handledBy: HandledBy;
  unreadCount: number;
  needsAttention: boolean;
  urgent: boolean;
  lastMessageAt: string;
  /** Set while a call on this conversation is live (status ringing, ai or ringing_team). */
  liveCall: { callId: string; status: CallStatus; startedAt: string } | null;
};

/** GET /api/conversations: newest first; `nextCursor` is null on the last page. */
export type ConversationPage = { items: ConversationListItem[]; nextCursor: string | null };

/** A tool action shown as a small card in the transcript ("Booked inspection Thu 10:00 with Sam"). */
export type ToolActionCard = {
  tool: string;
  ok: boolean;
  /** Plain sentence written by the server, e.g. "Booked inspection Thu 10:00 with Sam". */
  label: string;
  link: { kind: 'customer' | 'job' | 'appointment' | 'claim_intake'; id: string } | null;
};

/** One transcript line. `text` is null when the transcript was not kept (caller's request) or was swept. */
export type TurnView = {
  id: string;
  /** The call this turn was spoken on, or null for a text turn. */
  callId: string | null;
  position: number;
  speaker: TurnSpeaker;
  text: string | null;
  truncated: boolean;
  at: string;
  actions: ToolActionCard[];
};

export type CallView = {
  id: string;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  aiSeconds: number | null;
  recordingStatus: RecordingStatus;
  transcriptStored: boolean;
  transferResult: TransferResult;
  transferTo: { userId: string; name: string } | null;
  spamReason: string | null;
  /** Only for roles allowed to play it (spec §11); the signed URL itself comes from GET /api/calls/:id/recording. */
  canPlayRecording: boolean;
};

/** GET /api/conversations/:id. */
export type ConversationDetail = {
  id: string;
  channel: ConversationChannel;
  status: ConversationStatus;
  customer: { id: string; name: string } | null;
  phoneE164: string;
  outcome: ConversationOutcome | null;
  summary: string | null;
  followUps: string[];
  identity: IdentityLevel;
  handledBy: HandledBy;
  teamUntil: string | null;
  calls: CallView[];
  turns: TurnView[];
  links: {
    jobIds: string[];
    appointmentIds: string[];
    claimIntakeIds: string[];
  };
  /** True for texts: the reply box shows and POST /reply is allowed. */
  canReply: boolean;
};

/** POST /api/conversations/:id/reply body; errors come back as { error, field? } with a plain sentence. */
export type ReplyInput = { body: string };
/**
 * POST /api/conversations/:id/reply answer (200): the text went out, or the send gate will send it at
 * `scheduledFor` (quiet hours). A reply the gate blocks or that could not be sent is a 422 instead.
 */
export type ReplyResult = { id: string; status: 'sent' | 'scheduled'; scheduledFor: string | null };
/** POST /api/conversations/:id/handling body. */
export type HandlingInput = { by: HandledBy };

/** GET /api/calls/:id/recording: a 5-minute signed URL, fetched when the person presses play. */
export type RecordingLink = { url: string; expiresAt: string };

/** GET /api/front-desk/stats?week=YYYY-MM-DD (the Monday, company time zone). */
export type FrontDeskWeekStats = {
  weekStart: string;
  answered: number;
  booked: number;
  transferred: number;
  messages: number;
  spam: number;
  firstReplyMsP50: number | null;
  guardBlocks: number;
  aiMinutesUsed: number;
  aiMinutesIncluded: number | null;
};

/** One member on the on-call list, in ring order (Settings → Front Desk). */
export type OnCallMember = {
  userId: string;
  name: string;
  onCallOrder: number | null;
  transferPhoneE164: string | null;
  recordingAcknowledged: boolean;
};

/** GET/PUT /api/front-desk/settings (owner and office). PUT takes `FrontDeskSettingsInput`. */
export type FrontDeskSettings = {
  enabled: boolean;
  /** Why it can't be turned on, e.g. forwarding not verified; null when it can. */
  blockedReason: 'forwarding_not_verified' | 'no_number' | null;
  texts: boolean;
  voice: FrontDeskVoiceId;
  facts: string;
  canMove: boolean;
  canCancel: boolean;
  ringTeamFirstSeconds: number;
  missedCallTextBack: boolean;
  recordingRetentionDays: number;
  transcriptRetentionDays: number;
  maxConcurrentAiCalls: number;
  forwardingVerifiedAt: string | null;
  onCall: OnCallMember[];
};
export type FrontDeskSettingsInput = Omit<FrontDeskSettings, 'blockedReason' | 'forwardingVerifiedAt' | 'onCall'> & {
  /** User ids in ring order; members left out are taken off the list. */
  onCallOrder: string[];
  /** Owner only: turn Front Desk on although the forwarding test has not passed. */
  override?: boolean;
};

/** Limits the settings form and the route both enforce (spec §10). */
export const FRONT_DESK_LIMITS = {
  factsMaxChars: 2000,
  ringTeamFirstSeconds: { min: 0, max: 30 },
  recordingRetentionDays: { min: 0, max: 365 },
  transcriptRetentionDays: { min: 30, max: 730 },
  maxConcurrentAiCalls: { min: 1, max: 10 },
} as const;

/** GET /api/front-desk/voices. */
export type FrontDeskVoice = { id: FrontDeskVoiceId; label: string; previewUrl: string | null };

/** GET /api/me/transfer-phone and PUT body (Ruling DF: prefilled from the user's phone). */
export type TransferPhoneView = { e164: string | null; prefill: string | null; recordingAcknowledgedAt: string | null };
export type TransferPhoneInput = { e164: string; ackRecording: true };

/** POST /api/front-desk/forwarding-test → { id }; GET /api/front-desk/forwarding-test/:id. */
export type ForwardingTestView = {
  id: string;
  status: 'calling' | 'verified' | 'not_received' | 'failed';
  startedAt: string;
  finishedAt: string | null;
};
