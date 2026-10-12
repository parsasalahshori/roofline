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

const INSURER_CONTACT_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:call|calling|email|emailing|contact|contacting|talk to|talking to|speak (?:to|with)|speaking (?:to|with)|deal with|dealing with|handle|handling|negotiate with|negotiating with|work with|message)\\s+(?:your\\s+|the\\s+)?${INSURER}`,
  ),
  /on your behalf/,
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
  if (INSURER_CONTACT_PATTERNS.some((re) => re.test(lower))) add('insurer_contact');
  return { ok: hits.length === 0, hits };
}
