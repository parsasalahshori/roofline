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
 * D1 RC-1: the closed set of router intents (the router's json_schema enum and RouteDecision.intent).
 * Every intent the engine or shouldTransfer keys on is here.
 */
export const ROUTER_INTENTS = [
  'active_leak', 'adjuster', 'ask_for_person', 'cancel_appointment', 'complaint', 'confirm_appointment', 'danger', 'emergency', 'fire',
  'greeting', 'goodbye', 'human', 'injury', 'inspector', 'insurance_claim', 'insurance_question', 'job_status', 'leak', 'message',
  'not_understood', 'other', 'pricing', 'prompt_injection', 'quote', 'recording_objection', 'reschedule', 'sales_pitch',
  'schedule_inspection', 'spam', 'status', 'supplier', 'trade_caller', 'transfer', 'unknown',
] as const;
export type RouterIntent = (typeof ROUTER_INTENTS)[number];
/** Router intents that mean the caller is asking for a person. */
export const ASK_PERSON_INTENTS: ReadonlySet<string> = new Set<RouterIntent>(['ask_for_person', 'transfer', 'human']);

const LEAK_INTENTS = new Set(['leak', 'active_leak']);
const DANGER_INTENTS = new Set(['danger', 'injury', 'fire']);
const TRADE_INTENTS = new Set(['trade_caller', 'adjuster', 'inspector', 'supplier']);

/** First match wins, in the documented priority order. */
export function shouldTransfer(i: {
  intent: string;
  urgent: boolean;
  mood: 'calm' | 'upset' | 'angry';
  askedForPersonCount: number;
  taskInProgress: boolean;
  failedUnderstanding: number;
}): TransferReason | null {
  if (LEAK_INTENTS.has(i.intent)) return 'leak';
  if (DANGER_INTENTS.has(i.intent)) return 'danger';
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
