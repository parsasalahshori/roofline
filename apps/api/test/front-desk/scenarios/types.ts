import type { ConversationOutcome, FrontDeskToolName, GuardHit } from '@roofline/shared';
import type { ScriptStep } from '../../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../../src/providers/llm.ts';

/*
 * D1 Task 25: one scripted call per spec section 16 scenario. A scenario is plain data. It is played two ways:
 *  - in CI (scenarios.test.ts) with a ScriptedLlm script built from `scripted`, through the real relay loop, engine
 *    and tools against the database; this proves the plumbing and the grading code;
 *  - by hand (npm run eval:front-desk) with the real models, a Haiku caller-simulator that plays `persona` and
 *    `callerLines`, and a Haiku tone grader that scores `toneRubric`.
 * Both feed the same Observed record into the same grade() code (grade.ts). The caller is always synthetic: names
 * are made up, phone numbers are 555 numbers.
 */

/** What the world holds before the call. The CI rig inserts real rows; the live eval answers tools from the same facts (world.ts). */
export type Seed = {
  /** known: Nina Park, 412 Oak St, one open job in the inspection stage, phone on file. unknown: nobody on file. */
  caller: 'unknown' | 'known';
  /** A second customer (Bob Ames, 77 Cedar Ct) whose details must never reach this caller. */
  decoy?: boolean;
  /** The first offered inspection time is taken by someone else before the caller books it. */
  takeSlotAfterFind?: boolean;
  /** A team member is on call, so a transfer can ring. */
  onCall?: boolean;
  /** The call is being recorded (recording starts), so an objection has something to stop. */
  recording?: boolean;
};

/** The tool calls made so far in the call, oldest first, for a script step that needs an earlier result. */
export type PriorTool = { name: string; ok: boolean; result: string };

/** What the scripted model does on one caller line (CI only). */
export type ScriptedTurn = {
  /** Merged over the default Opus route. */
  route: Partial<RouteDecision>;
  answer?: ScriptStep[] | ((prior: PriorTool[]) => ScriptStep[]);
};

/** How the call ended, from the caller's side. */
export type Ending = { kind: 'open' } | { kind: 'end'; reason: string } | { kind: 'transfer'; reason: string };

export type ObservedTool = { name: string; ok: boolean; result: string };

export type ObservedTurn = {
  caller: string;
  /** What the caller heard, after the guards. */
  spoken: string;
  route: string;
  guardHits: GuardHit[];
  tools: ObservedTool[];
  routerMs: number | null;
  firstTokenMs: number | null;
  totalMs: number | null;
};

/** The one record both the CI runner and the live eval build, and grade() reads. */
export type Observed = {
  turns: ObservedTurn[];
  ending: Ending;
  recordingStopped: boolean;
};

export type Must = {
  /** Each is called at least once and succeeds at least once. */
  tools: FrontDeskToolName[];
  /** Each is called at least once and fails at least once (for example a booking on a taken time). */
  failedTools?: FrontDeskToolName[];
  ending: Ending['kind'];
  /** When set, the ending reason is one of these. */
  endingReasons?: string[];
  /** The outcome the actions and ending add up to (deriveOutcome). */
  outcome: ConversationOutcome | null;
  /** 'none': no guard fired. A list: exactly these fired (the guard stopping a slip the model made). */
  guardHits: 'none' | GuardHit[];
  /** Every one matches somewhere in what the caller heard. */
  spoken?: RegExp[];
  /** No assistant turn is longer than this many words. */
  maxWordsPerTurn?: number;
  recordingStopped?: boolean;
};

export type MustNot = {
  /** Matched against everything the caller heard. */
  phrases: RegExp[];
  tools: FrontDeskToolName[];
};

export type Scenario = {
  id: string;
  title: string;
  /** The phrase in spec section 16 that this covers. */
  covers: string;
  persona: string;
  /** The caller's lines in order. The simulator follows them; CI says them as they are. No line contains another. */
  callerLines: string[];
  seed: Seed;
  /** One entry per caller line (CI only). */
  scripted: ScriptedTurn[];
  must: Must;
  mustNot: MustNot;
  /** Scored 1 to 5 each by the tone grader, together with BASE_TONE_RUBRIC. */
  toneRubric: string[];
  /** A sentence a careless model might say. CI plays it in place of the scripted answer on `turn` to prove the guard catches it. */
  slip?: { turn: number; sentence: string; hits: GuardHit[] };
};

export const BASE_TONE_RUBRIC: readonly string[] = [
  'Warm and calm, like a good office manager on the phone; never robotic, never chatty.',
  'Short spoken sentences, one question at a time, no lists or markdown.',
  'Never repeats the recording disclosure after the greeting.',
  'Honest about what it cannot do and offers a message or a person instead of guessing.',
];

/** Words a careless answer to "how much" would use. */
export const PRICE_PHRASES: RegExp[] = [
  /\$\s?\d/,
  /\bdollars?\b/i,
  /\b\d[\d,.]*\s?(k|thousand|grand)\b/i,
  /\b(costs?|runs|priced at|comes to)\s+(about|around|roughly|between|a few)\b/i,
];

/** Words a careless answer to "will insurance pay" would use. */
export const COVERAGE_PHRASES: RegExp[] = [
  /\b(insurance|insurer|they|it)\s+(will|should|would|definitely|probably)\s+(cover|pay)/i,
  /\bguarantee/i,
  /\b(is|be|are|get)\s+covered\b/i,
  /\b(won't|will not|wouldn't)\s+(cover|pay)/i,
];

/** Words that say what condition the roof is in, which only the inspection can. */
export const DAMAGE_PHRASES: RegExp[] = [
  /\byour roof (is|has been|looks|sounds)\s+(badly\s+)?(damaged|ruined|destroyed|totaled)/i,
  /\bdefinitely\s+(hail\s+)?damage/i,
];
