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

// ---------------------------------------------------------------------------
// Guards: every sentence the assistant speaks passes through guardSentence.
// ---------------------------------------------------------------------------

export type GuardHit = 'price' | 'coverage' | 'damage';

/** Spoken server text (spec section 7.2). */
export function priceGuardReplacement(repName: string | null): string {
  return `I can't give prices on the phone, but ${repName ?? 'our estimator'} will go over that at the inspection.`;
}
export const PRICE_GUARD_REPLACEMENT = priceGuardReplacement(null);
export const COVERAGE_GUARD_REPLACEMENT =
  'Whether insurance covers it is up to your insurance company; we can help you with the claim.';
export const DAMAGE_GUARD_REPLACEMENT = 'The inspection will tell us.';

const APOS = `['’]`;
const UNIT_WORDS =
  'zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen';
const TENS_WORDS = 'twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety';
const SMALL_UNITS = 'one|two|three|four|five|six|seven|eight|nine';
const NUM_WORD = `(?:(?:${TENS_WORDS})(?:[\\s-]+(?:${SMALL_UNITS}))?|${UNIT_WORDS}|a\\s+couple(?:\\s+of)?|couple(?:\\s+of)?|a\\s+few|several)`;
const NUM = `(?:\\d[\\d,]*(?:\\.\\d+)?|${NUM_WORD})`;

const PRICE_PATTERNS: RegExp[] = [
  /\$\s?\d/,
  /\b(?:dollars?|bucks?)\b/,
  new RegExp(`\\b${NUM}\\s*(?:a|per|each)\\s+(?:sq(?:uare)?\\b|square\\b)`),
  new RegExp(`\\b${NUM}\\s*\\/\\s*sq`),
  /\bper\s+square\b/,
  /\bcosts?\s+(?:about|around|roughly|approximately|between)\b/,
  /\bestimate\s+is\b/,
  /\b\d[\d,]*(?:\.\d+)?\s?k\b/,
  new RegExp(`\\b${NUM_WORD}\\s?k\\b`),
  new RegExp(`\\b(?:${NUM}|a)\\s+grand\\b`),
  new RegExp(`\\b${NUM_WORD}[\\s-]+(?:hundred|thousand|million)\\b(?!\\s+percent)`),
  /\b\d[\d,]*(?:\.\d+)?\s+(?:hundred|thousand|million)\b(?!\s+percent)/,
  new RegExp(
    `\\b(?:costs?|costing|price[sd]?|pricing|charges?|charged|quoted|totals?|totaling|run\\s+you|set\\s+you\\s+back)\\b(?:\\s+(?:is|was|will\\s+be|would\\s+be|of|at|about|around|roughly|approximately|maybe|probably|like|just|only|under|over|you))*\\s+(?:\\d|${NUM_WORD}\\b|a\\s+(?:hundred|thousand|million)\\b)`,
  ),
  /\ba\s+(?:hundred|thousand)\b(?!\s+(?:percent|times|years?|feet|foot|miles?|people|homes?|houses?|roofs?|jobs?|customers?|reviews?)\b)/,
];

const COVERAGE_PATTERNS: RegExp[] = [
  new RegExp(
    `\\b(?:insurance(?:\\s+(?:company|carrier|policy))?|your\\s+(?:insurer|policy|carrier))\\s*(?:will|should|would|can|could|might|must|has\\s+to|is\\s+going\\s+to|is\\s+gonna|${APOS}ll|${APOS}d|won${APOS}t|wouldn${APOS}t|shouldn${APOS}t|can${APOS}t|doesn${APOS}t|does\\s+not)(?:\\s+not)?\\s+(?:definitely\\s+|probably\\s+|likely\\s+|totally\\s+|fully\\s+)?(?:pay|cover|replace|handle|take\\s+care\\s+of|foot\\s+the\\s+bill)`,
  ),
  new RegExp(`\\bthey(?:${APOS}ll|\\s+will|\\s+should|\\s+would)\\s+(?:probably\\s+|definitely\\s+)?(?:pay\\s+for\\b|cover\\b(?!\\s+up\\b)(?![^.?!]*\\b(?:tarps?|plastic|with)\\b))`),
  /(?<!\bwhether\s)\binsurance(?:\s+(?:company|carrier|policy))?\s+(?:covers|pays)\b/,
  new RegExp(
    `\\b(?:you|they|insurance|your\\s+insurer|the\\s+insurance\\s+company)(?:${APOS}ll|\\s+will|\\s+would|\\s+are\\s+going\\s+to|\\s+are\\s+gonna)\\s+(?:definitely\\s+|probably\\s+)?(?:get|receive)\\s+(?:a\\s+)?(?:brand\\s+)?new\\s+roof\\b`,
  ),
  new RegExp(`\\b(?:they|insurance|your\\s+insurer)(?:${APOS}ll|\\s+will|\\s+would)\\s+replace\\s+(?:your|the)\\s+roof\\b`),
  new RegExp(`\\b(?:you|it|that|this|everything|roof)(?:${APOS}re|${APOS}s|\\s+are|\\s+is|${APOS}ll\\s+be|\\s+will\\s+be|\\s+would\\s+be)\\s+(?:all\\s+|fully\\s+|definitely\\s+|totally\\s+)?covered\\b`),
  /\b(?:is|are|be|get|got)\s+covered\b.*\b(?:insurance|claim|policy)\b|\b(?:insurance|claim|policy)\b.*\b(?:is|are|be|get|got)\s+covered\b/,
  /\bcovered\s+(?:by|under)\s+(?:your\s+|the\s+)?(?:insurance|policy|claim)\b/,
  /\bguarantee(?:s|d)?\b/,
];

const DAMAGE_PATTERNS: RegExp[] = [
  /(?<!\b(?:if|whether|when|do|does|did)\s+)\b(?:your|the)\s+(?:roof|shingles|siding|gutters|flashing|home|house)\s+(?:is|was|are|were|looks?|seems?|got|has\s+been|have\s+been)\s+(?:(?:definitely|probably|clearly|badly|totally|obviously|severely)\s+)?(?:damaged|ruined|shot|totaled)\b/,
  new RegExp(`(?<!\\b(?:if|whether|when)\\s+)\\bthere(?:${APOS}s|\\s+is)\\s+(?:definitely\\s+|clearly\\s+|probably\\s+)?(?:(?:hail|storm|wind|water|roof)\\s+)?damage\\b`),
  /(?<!\b(?:if|whether|when|do|does|did)\s+)\b(?:your|the)\s+roof\s+has\s+(?:(?:definitely|clearly|obviously|some|major|serious)\s+)?(?:hail|storm|wind|water|roof)\s+damage\b/,
  new RegExp(
    `(?<!\\b(?:if|whether|when|do|does|did|and|so)\\s+)\\byou(?:\\s+have|${APOS}ve\\s+got|\\s+got)\\s+(?:(?:hail|storm|wind|water|roof)\\s+)?damage\\b`,
  ),
  new RegExp(`(?<!\\b(?:if|whether|when)\\s+)\\bit(?:${APOS}s|\\s+is)\\s+(?:(?:definitely|probably|clearly|badly|totally)\\s+)?damaged\\b`),
];

const DAMAGE_QUESTION = /^(?:do|does|did|is|are|was|were|can|could|would|will|has|have|how|what|where|when|why|which|who)\b[^?]*\?\s*$/;

export function guardSentence(s: string, ctx: { repName: string | null }): { text: string; hits: GuardHit[] } {
  const lower = s.toLowerCase();
  const hits: GuardHit[] = [];
  if (PRICE_PATTERNS.some((re) => re.test(lower))) hits.push('price');
  if (COVERAGE_PATTERNS.some((re) => re.test(lower))) hits.push('coverage');
  if (!DAMAGE_QUESTION.test(lower.trim()) && DAMAGE_PATTERNS.some((re) => re.test(lower))) hits.push('damage');
  if (hits.length === 0) return { text: s, hits };
  const parts = hits.map((h) =>
    h === 'price' ? priceGuardReplacement(ctx.repName) : h === 'coverage' ? COVERAGE_GUARD_REPLACEMENT : DAMAGE_GUARD_REPLACEMENT,
  );
  return { text: parts.join(' '), hits };
}

// ---------------------------------------------------------------------------
// SentenceBuffer: turns a token stream into whole sentences.
// ---------------------------------------------------------------------------

const MAX_SENTENCE_CHARS = 140;
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'ave', 'rd', 'a.m', 'p.m', 'vs', 'no', 'jr', 'sr']);

export class SentenceBuffer {
  private buffer = '';

  push(token: string): string[] {
    this.buffer += token;
    const out = this.extract(false);
    this.splitLong(out, false);
    return out;
  }

  flush(): string[] {
    const out = this.extract(true);
    this.splitLong(out, true);
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) out.push(rest);
    return out;
  }

  private isAbbreviation(end: number, termStart: number): boolean {
    // Only a single period can belong to an abbreviation.
    if (this.buffer[termStart] !== '.' || end - termStart !== 1) return false;
    const m = /([A-Za-z][A-Za-z.]*)$/.exec(this.buffer.slice(0, termStart));
    if (!m) return false;
    const word = m[1]!.toLowerCase();
    if (ABBREVIATIONS.has(word)) return true;
    return /^[A-Z]$/.test(m[1]!); // initials such as "J. Smith"
  }

  private extract(final: boolean): string[] {
    const out: string[] = [];
    let start = 0;
    let i = 0;
    const b = this.buffer;
    while (i < b.length) {
      const c = b[i]!;
      if (c !== '.' && c !== '?' && c !== '!') {
        i++;
        continue;
      }
      const termStart = i;
      let j = i + 1;
      while (j < b.length && '.?!'.includes(b[j]!)) j++;
      while (j < b.length && `"'”’)]}`.includes(b[j]!)) j++;
      if (j >= b.length) {
        if (!final) break; // undecided: wait for the next token
        j = b.length;
      } else if (!/\s/.test(b[j]!)) {
        i = j; // "3.5", "a.m.x": not a boundary
        continue;
      }
      if (j < b.length && this.isAbbreviation(termStart + 1, termStart)) {
        i = j;
        continue;
      }
      const sentence = b.slice(start, j).trim();
      if (sentence) out.push(sentence);
      start = j;
      i = j;
    }
    this.buffer = b.slice(start).replace(/^\s+/, '');
    return out;
  }

  private splitLong(out: string[], final: boolean): void {
    while (final ? this.buffer.length > MAX_SENTENCE_CHARS : this.buffer.length >= MAX_SENTENCE_CHARS) {
      const head = this.buffer.slice(0, MAX_SENTENCE_CHARS + 1);
      const comma = head.lastIndexOf(',', MAX_SENTENCE_CHARS - 1);
      let cut: number;
      if (comma > 0) cut = comma + 1;
      else {
        const space = head.lastIndexOf(' ');
        cut = space > 0 ? space : MAX_SENTENCE_CHARS;
      }
      const piece = this.buffer.slice(0, cut).trim();
      if (piece) out.push(piece);
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '');
    }
  }
}
