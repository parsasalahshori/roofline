import { guardSentence } from './front-desk.ts';
import type { GuardHit } from './front-desk.ts';

/** G1 claims guard (Task 2b): D1's sentence guard plus claims-specific refusals. */
export type ClaimsGuardHit = GuardHit | 'deductible' | 'insurer_contact';

const INSURER = '(?:insurance(?:\\s+company)?|insurer|adjuster|carrier)';

const DEDUCTIBLE_PATTERNS: RegExp[] = [
  /deductible[^.!?]{0,40}(?:waiv|cover|paid|pay|absorb|rebat)/,
  /(?:waiv|cover|pay|paying|absorb|rebat|take care of|taking care of)[^.!?]{0,40}deductible/,
  /no out[ -]of[ -]pocket/,
  /upgrade[^.!?]{0,30}paid (?:for )?by (?:your )?insurance/,
  /paid for by (?:your )?insurance/,
];

const CONTACT_VERB =
  '(?:call|phone|text|email|contact|reach out to|talk to|talk with|speak to|speak with|deal with|handle|negotiate with|work with|message|meet with|get in touch with)';
const FIRST_PERSON = "(?:we|we'll|we will|we can|we're|we are|we'd|i|i'll|i will|i can|i'd|let us|let me|our team|our office|our staff)";

/**
 * An offer to contact or negotiate with the insurer or adjuster for the homeowner. Only a
 * first-person subject ("we'll call your insurer") or an explicit "for you" / "on your behalf"
 * next to an insurer word counts: telling the homeowner to contact their own insurer is fine.
 */
const INSURER_CONTACT_PATTERNS: RegExp[] = [
  // "We'll call your insurer", "I can talk to the adjuster" (not "we work with insurance claims").
  new RegExp(`\\b${FIRST_PERSON}\\b[^.!?]{0,30}\\b${CONTACT_VERB}\\s+(?:your\\s+|the\\s+)?${INSURER}(?!\\s+claims?\\b)`),
  // "... for you" / "on your behalf" in a sentence about the insurer, adjuster or claim.
  /^(?=.*\b(?:for you|on your behalf)\b)(?=.*\b(?:insurance|insurer|adjuster|carrier|claim)\b)/,
];

export function claimsGuard(text: string): { ok: boolean; hits: ClaimsGuardHit[] } {
  const hits: ClaimsGuardHit[] = [];
  const add = (h: ClaimsGuardHit): void => {
    if (!hits.includes(h)) hits.push(h);
  };
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
  for (const s of sentences) {
    for (const h of guardSentence(s, { repName: null }).hits) add(h);
  }
  const lower = text.replace(/’/g, "'").toLowerCase();
  if (
    DEDUCTIBLE_PATTERNS.some((re) => re.test(lower)) ||
    (/free roof/.test(lower) && /insurance|claim/.test(lower))
  ) {
    add('deductible');
  }
  const lowerSentences = lower.split(/(?<=[.!?])\s+/);
  if (lowerSentences.some((sentence) => INSURER_CONTACT_PATTERNS.some((re) => re.test(sentence)))) {
    add('insurer_contact');
  }
  return { ok: hits.length === 0, hits };
}
