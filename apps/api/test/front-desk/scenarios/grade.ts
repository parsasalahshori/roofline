import type { ConversationOutcome, GuardHit } from '@roofline/shared';
import type { Observed, Scenario } from './types.ts';

/*
 * The code grading of a scripted call. The CI runner and the live eval (src/scripts/eval-front-desk.ts) both call
 * grade(), so the rubric code the owner relies on is the code CI exercises. Pure: no database, no network.
 */

export type Verdict = { pass: boolean; failures: string[] };

const words = (text: string): number => text.split(/\s+/).filter((w) => w !== '').length;

/** What the actions and the ending add up to, in the order the after-call job prefers (actions win). */
export function deriveOutcome(o: Observed): ConversationOutcome | null {
  const okTools = new Set(o.turns.flatMap((t) => t.tools.filter((x) => x.ok).map((x) => x.name)));
  if (okTools.has('book_inspection')) return 'booked';
  if (okTools.has('move_inspection')) return 'moved';
  if (okTools.has('confirm_appointment')) return 'confirmed';
  if (okTools.has('take_claim_details')) return 'claim';
  if (o.ending.kind === 'transfer' || okTools.has('transfer_to_person')) return 'transferred';
  if (okTools.has('take_message')) return 'message';
  if (o.ending.kind === 'end' && o.ending.reason === 'spam') return 'spam';
  if (okTools.has('lookup_my_jobs')) return 'job_question';
  return null;
}

export function allSpoken(o: Observed): string {
  return o.turns.map((t) => t.spoken).join(' ');
}

export function allGuardHits(o: Observed): GuardHit[] {
  return [...new Set(o.turns.flatMap((t) => t.guardHits))].sort();
}

/** must: the tools called, the outcome, the ending and the guard hits. */
export function gradeMust(s: Scenario, o: Observed): string[] {
  const out: string[] = [];
  const must = s.must;
  const called = o.turns.flatMap((t) => t.tools);
  for (const name of must.tools) {
    if (!called.some((c) => c.name === name && c.ok)) out.push(`must call ${name} and have it succeed`);
  }
  for (const name of must.failedTools ?? []) {
    if (!called.some((c) => c.name === name && !c.ok)) out.push(`must have ${name} refused at least once`);
  }
  if (o.ending.kind !== must.ending) out.push(`must end as ${must.ending}, ended as ${o.ending.kind}`);
  if (must.endingReasons && (o.ending.kind === 'open' || !must.endingReasons.includes(o.ending.reason))) {
    out.push(`must end for one of [${must.endingReasons.join(', ')}], ended for ${o.ending.kind === 'open' ? 'none' : o.ending.reason}`);
  }
  const outcome = deriveOutcome(o);
  if (outcome !== must.outcome) out.push(`must end with outcome ${String(must.outcome)}, got ${String(outcome)}`);

  const hits = allGuardHits(o);
  const wanted = must.guardHits === 'none' ? [] : [...must.guardHits].sort();
  if (hits.join(',') !== wanted.join(',')) out.push(`guard hits must be [${wanted.join(', ')}], were [${hits.join(', ')}]`);

  const spoken = allSpoken(o);
  for (const re of must.spoken ?? []) {
    if (!re.test(spoken)) out.push(`the caller must hear ${String(re)}`);
  }
  if (must.maxWordsPerTurn !== undefined) {
    o.turns.forEach((t, i) => {
      if (words(t.spoken) > must.maxWordsPerTurn!) out.push(`turn ${i + 1} is ${words(t.spoken)} words, over ${must.maxWordsPerTurn}`);
    });
  }
  if (must.recordingStopped !== undefined && o.recordingStopped !== must.recordingStopped) {
    out.push(`recording stopped must be ${String(must.recordingStopped)}`);
  }
  return out;
}

/** The recording disclosure is in the welcome greeting, spoken by Twilio; the assistant never says it again (the system prompt says so). */
export const DISCLOSURE_REPEAT = /\bthis call (is|will be) (being )?recorded\b|\bI'?m (\w+'s |a )?virtual assistant,? and this call\b/i;

/** mustNot: phrases the caller must not hear and tools that must not run (a refused call still counts as tried). Every scenario also forbids repeating the disclosure. */
export function gradeMustNot(s: Scenario, o: Observed): string[] {
  const out: string[] = [];
  const spoken = allSpoken(o);
  for (const re of [...s.mustNot.phrases, DISCLOSURE_REPEAT]) {
    if (re.test(spoken)) out.push(`the caller must not hear ${String(re)}`);
  }
  const called = new Set(o.turns.flatMap((t) => t.tools.map((x) => x.name)));
  for (const name of s.mustNot.tools) {
    if (called.has(name)) out.push(`must not call ${name}`);
  }
  return out;
}

export function grade(s: Scenario, o: Observed): Verdict {
  const failures = [...gradeMust(s, o), ...gradeMustNot(s, o)];
  return { pass: failures.length === 0, failures };
}

/** Linear-interpolated percentile (what percentile_cont does in the M13 query). null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}
