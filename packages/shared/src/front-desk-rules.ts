import type { IdentityLevel } from './front-desk.ts';

/** Front Desk (D1) transfer, text-back, identity and limit rules. Pure functions. */

export type TransferReason =
  | 'asked'
  | 'leak'
  | 'danger'
  | 'angry'
  | 'trade_caller'
  | 'not_understood'
  | 'model_failure';

/**
/**
 * The closed set of router intents (the router's json_schema enum). Every intent the engine, shouldTransfer, the
 * scenarios and the eval key on is here, including the leak/danger vocabulary of Ruling BK (amended).
 */
export const ROUTER_INTENTS = [
  'active_leak', 'adjuster', 'ask_for_person', 'cancel_appointment', 'complaint', 'confirm_appointment', 'danger', 'emergency', 'fire',
  'greeting', 'goodbye', 'human', 'injury', 'inspector', 'insurance_claim', 'insurance_question', 'job_status', 'leak', 'message',
  'not_understood', 'other', 'pricing', 'prompt_injection', 'quote', 'recording_objection', 'reschedule', 'sales_pitch',
  'schedule_inspection', 'spam', 'status', 'storm_damage_active', 'supplier', 'trade_caller', 'transfer', 'unknown', 'water_inside',
] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];
/** Router intents that mean the caller is asking for a person (RC-1: the engine and transfer count them once per turn). */
export const ASK_PERSON_INTENTS: ReadonlySet<string> = new Set<RouterIntent>(['ask_for_person', 'transfer', 'human']);

/**
 * Ruling BK (amended): the router's emergency vocabulary. ROUTER_PROMPT names these words, so the router emits them.
 * 'emergency' alone does not say which kind, so the caller's words decide (see emergencyReason).
 */
export const EMERGENCY_INTENTS: ReadonlySet<RouterIntent> = new Set<RouterIntent>([
  'leak',
  'active_leak',
  'emergency',
  'danger',
  'injury',
  'fire',
  'water_inside',
  'storm_damage_active',
]);
const LEAK_INTENTS = new Set(['leak', 'active_leak', 'water_inside', 'storm_damage_active']);
const DANGER_INTENTS = new Set(['danger', 'injury', 'fire']);
const TRADE_INTENTS = new Set(['trade_caller', 'adjuster', 'inspector', 'supplier']);

/**
 * The router's intent is a short label, so its meaning is matched loosely too (RC-4): a substring is enough on a label
 * ('gas_smell', 'roof_leaking'). 'emergenc' is kept apart so the caller's words can say which kind of emergency it is.
 */
const LEAK_LABEL = /leak|water|flood|drip/i;
const DANGER_LABEL = /danger|injur|hurt|fire|smoke|gas|electr|spark|collaps/i;
const EMERGENCY_LABEL = /emergenc/i;
/** The caller's own words, matched on word starts (looser substrings would catch "Vegas" or "electrician"). */
const DANGER_PHRASES =
  /\b(danger\w*|gas|smell\w* (of )?(gas|smoke|burning)|sparks?|sparking|arcing|live wires?|electrocut\w*|fire|flames?|smoke|burning|injur\w*|hurt|bleeding|unconscious|collaps\w*|caved? in|fell (off|through))\b/i;
const LEAK_PHRASES =
  /\b(leak\w*|water (is |was |keeps )?(coming|pouring|dripping|running|getting|gushing|flowing)|pour\w* (in|through|into|down)|drip\w*|flood\w*|soak\w*)\b/i;

/**
 * Leak or danger, in this order: the router's intent in the vocabulary (any case); a loose match on the intent label
 * (danger before leak); the caller's words or a summary of them (danger before leak); then an 'emergency' label with
 * no telling words is danger. A bare "it's urgent" with no leak or danger word is null.
 */
export function emergencyReason(intent: string, callerText?: string): 'leak' | 'danger' | null {
  const label = intent.trim().toLowerCase();
  if (LEAK_INTENTS.has(label)) return 'leak';
  if (DANGER_INTENTS.has(label)) return 'danger';
  if (DANGER_LABEL.test(label)) return 'danger';
  if (LEAK_LABEL.test(label)) return 'leak';
  const words = callerText ?? '';
  if (DANGER_PHRASES.test(words)) return 'danger';
  if (LEAK_PHRASES.test(words)) return 'leak';
  return EMERGENCY_LABEL.test(label) ? 'danger' : null;
}

/**
 * First match wins, in the documented priority order. `callerText` (optional) is the caller's utterance or a summary
 * of it, matched loosely for leak and danger words (Ruling BK amended).
 */
export function shouldTransfer(
  i: {
    intent: string;
    urgent: boolean;
    mood: 'calm' | 'upset' | 'angry';
    askedForPersonCount: number;
    taskInProgress: boolean;
    failedUnderstanding: number;
  },
  callerText?: string,
): TransferReason | null {
  const emergency = emergencyReason(i.intent, callerText);
  if (emergency !== null) return emergency;
  if (i.mood === 'angry') return 'angry';
  if (TRADE_INTENTS.has(i.intent)) return 'trade_caller';
  if (i.intent === 'model_failure') return 'model_failure';
  // A person-ask (intent ask_for_person/transfer/human or count alone; the count carries it): a second ask is needed mid-task.
  const needed = i.taskInProgress ? 2 : 1;
  if (i.askedForPersonCount >= needed) return 'asked';
  if (i.failedUnderstanding >= 3) return 'not_understood';
  return null;
}

export function transferPlan(i: {
  reason: TransferReason;
  urgent: boolean;
  inWorkHours: boolean;
  onCall: { userId: string; phone: string }[];
}): { mode: 'ring_all' | 'ring_each' | 'message'; targets: { userId: string; phone: string }[]; timeoutSeconds: 20 } {
  const urgent = i.urgent || i.reason === 'leak' || i.reason === 'danger';
  if (i.onCall.length === 0) return { mode: 'message', targets: [], timeoutSeconds: 20 };
  if (i.inWorkHours) return { mode: 'ring_all', targets: [...i.onCall], timeoutSeconds: 20 };
  if (urgent) return { mode: 'ring_each', targets: [...i.onCall], timeoutSeconds: 20 };
  return { mode: 'message', targets: [], timeoutSeconds: 20 };
}

/**
 * Decision 11. Mobile numbers only. A failed call always qualifies; otherwise the
 * caller must have hung up before their first turn or within 15 seconds. Statuses
 * 'busy' and 'no_answer' follow the same hang-up rule as 'completed'.
 */
export function shouldTextBack(i: {
  callerTurns: number;
  secondsInCall: number;
  status: 'failed' | 'completed' | 'no_answer' | 'busy';
  lineType: 'mobile' | 'landline' | 'voip' | 'unknown';
  spam: boolean;
  textedBackLast24h: boolean;
  enabled: boolean;
}): boolean {
  if (!i.enabled || i.spam || i.textedBackLast24h || i.lineType !== 'mobile') return false;
  if (i.status === 'failed') return true;
  return i.callerTurns === 0 || i.secondsInCall <= 15;
}

/** Turn-limit constants: a conversation is offered a person at this many caller turns (and this many minutes), ended at the end minutes. */
export const TURN_LIMIT_OFFER_TURNS = 40;
export const TURN_LIMIT_OFFER_MINUTES = 25;
export const TURN_LIMIT_END_MINUTES = 30;

/** The start of verify_caller's mismatch replies; the stored tool-call result of a failed try begins with it. */
export const VERIFY_MISMATCH_PREFIX = 'That did not match our records';

export function turnLimit(i: { turns: number; minutes: number }): 'ok' | 'offer_person' | 'end' {
  if (i.minutes >= TURN_LIMIT_END_MINUTES) return 'end';
  if (i.turns >= TURN_LIMIT_OFFER_TURNS || i.minutes >= TURN_LIMIT_OFFER_MINUTES) return 'offer_person';
  return 'ok';
}

/** Never returns 'verified': that happens through verifyCaller in a tool. Shared phones are never guessed. */
export function matchCaller(
  phoneMatches: { customerId: string; firstName: string; lastName: string; streets: string[] }[],
): IdentityLevel {
  const ids = new Set(phoneMatches.map((m) => m.customerId));
  return ids.size === 1 ? 'matched' : 'unknown';
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SUFFIXES = new Set([
  'st', 'street', 'ave', 'avenue', 'rd', 'road', 'dr', 'drive', 'ln', 'lane', 'blvd', 'boulevard',
  'ct', 'court', 'cir', 'circle', 'way', 'pl', 'place', 'pkwy', 'parkway', 'ter', 'terrace',
]);
const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'north', 'south', 'east', 'west']);

function streetParts(s: string): { number: string | null; words: string[] } {
  const tokens = norm(s).split(' ').filter(Boolean);
  let number: string | null = null;
  if (tokens.length > 0 && /^\d+$/.test(tokens[0]!)) number = tokens.shift()!;
  const words = tokens.filter((t) => !SUFFIXES.has(t) && !DIRECTIONALS.has(t));
  return { number, words };
}

export function verifyCaller(
  c: { lastName: string; streets: string[] },
  said: { name: string; street: string },
): boolean {
  const last = norm(c.lastName);
  const saidName = norm(said.name);
  if (!last || !saidName) return false;
  if (!(' ' + saidName + ' ').includes(' ' + last + ' ')) return false;

  const sp = streetParts(said.street);
  if (sp.words.length === 0) return false;
  return c.streets.some((st) => {
    const stored = streetParts(st);
    if (sp.number !== null && sp.number !== stored.number) return false;
    return stored.words.length === sp.words.length && stored.words.every((w, k) => w === sp.words[k]);
  });
}
