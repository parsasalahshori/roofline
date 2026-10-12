// Pure parts of the hand-run agent-text eval (G1 Task 18a): arguments and refusals, the fixture
// check, the fact extractor and the code checks, the cost estimate, the grade-answer parser and the
// markdown report. Nothing here touches the network; scripts/eval-agent-texts.ts does the calls.
import { z } from 'zod';
import { claimsGuard, guardSentence, type ClaimsGuardHit, type GuardHit } from '@roofline/shared';
import { DRAFT_MAX_TOKENS } from '../../apps/api/src/providers/anthropic/draft-texts.ts';
import { DRAFT_KINDS, type DraftDropReason, type DraftKind, type JobFacts, type TurnUsage } from '../../apps/api/src/providers/llm.ts';

// ---------------------------------------------------------------------------
// Models and prices
// ---------------------------------------------------------------------------

/** The config default for AGENT_DRAFT_MODEL (apps/api/src/config.ts). */
export const DEFAULT_DRAFT_MODEL = 'claude-opus-5-5';
/** The grader, named by the G1 lead. */
export const GRADE_MODEL = 'claude-haiku-5-5';

/** US dollars per million tokens. The one price table: add a model here before evaluating it. */
export const PRICES_PER_MTOK: Readonly<Record<string, { input: number; output: number; cacheRead: number }>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

/**
 * Conservative per-case token guesses (no network, so no countTokens). A draft sends the system
 * prompt, the kind's instruction and one job's facts (well under 1,000 tokens) and gets adaptive
 * thinking plus one short JSON text back. `ceiling` is each call's max_tokens: draft-texts.ts asks
 * for DRAFT_MAX_TOKENS (6,000), the grader for 1,024.
 */
export const TOKEN_ESTIMATE = {
  draft: { input: 1_200, output: 1_500, ceiling: DRAFT_MAX_TOKENS },
  grade: { input: 800, output: 400, ceiling: 1_024 },
} as const;

export type CostEstimate = { cases: number; typical: number; ceiling: number };

export function priceOf(model: string): { input: number; output: number; cacheRead: number } | null {
  return Object.hasOwn(PRICES_PER_MTOK, model) ? PRICES_PER_MTOK[model]! : null;
}

/** One draft and one grade per case. Throws when a model has no price in PRICES_PER_MTOK. */
export function estimateCost(cases: number, draftModel: string, gradeModel: string): CostEstimate {
  const d = priceOf(draftModel);
  const g = priceOf(gradeModel);
  if (!d) throw new Error(`No price for ${draftModel}: add it to PRICES_PER_MTOK first.`);
  if (!g) throw new Error(`No price for ${gradeModel}: add it to PRICES_PER_MTOK first.`);
  const per = (inTok: number, outTok: number, p: { input: number; output: number }): number =>
    (inTok * p.input + outTok * p.output) / 1_000_000;
  const { draft, grade } = TOKEN_ESTIMATE;
  return {
    cases,
    typical: cases * (per(draft.input, draft.output, d) + per(grade.input, grade.output, g)),
    ceiling: cases * (per(draft.input, draft.ceiling, d) + per(grade.input, grade.ceiling, g)),
  };
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 0.1 ? 4 : 2)}`;
}

export function describeEstimate(e: CostEstimate, draftModel: string, gradeModel: string): string {
  return (
    `Estimated cost: about ${formatUsd(e.typical)} (at most ${formatUsd(e.ceiling)} if every answer hits max_tokens) ` +
    `for ${e.cases} drafts on ${draftModel} and ${e.cases} grades on ${gradeModel}.`
  );
}

export type Tokens = { input: number; cachedRead: number; output: number };

export function costOf(t: Tokens, model: string): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (t.input * p.input + t.cachedRead * p.cacheRead + t.output * p.output) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Arguments and refusals
// ---------------------------------------------------------------------------

export type EvalArgs = { confirmSpend: boolean; only: string[] | null };

export class ArgError extends Error {}

/** `--confirm-spend` and `--only <id>[,<id>...]` (repeatable). Anything else is refused. */
export function parseArgs(argv: readonly string[]): EvalArgs {
  let confirmSpend = false;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--confirm-spend') {
      confirmSpend = true;
    } else if (a === '--only' || a.startsWith('--only=')) {
      const value = a === '--only' ? argv[++i] : a.slice('--only='.length);
      const ids = (value ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (ids.length === 0) throw new ArgError('--only needs one or more case ids, like --only lead-01,claims-03.');
      only = [...(only ?? []), ...ids];
    } else {
      throw new ArgError(`Unknown argument: ${a}. Use --confirm-spend and, optionally, --only <case ids>.`);
    }
  }
  return { confirmSpend, only };
}

export type Preflight = { ok: true; apiKey: string } | { ok: false; message: string };

/**
 * The refusals, in order: never in CI; a confirm flag for the spend; a key. The messages never
 * contain the key.
 */
export function preflight(args: EvalArgs, env: Readonly<Record<string, string | undefined>>): Preflight {
  if (env.CI && env.CI !== '0' && env.CI !== 'false') {
    return { ok: false, message: 'Refusing to run in CI: this eval calls paid models and is run by hand only.' };
  }
  if (!args.confirmSpend) {
    return { ok: false, message: 'Refusing to spend: run again with --confirm-spend to call the models.' };
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, message: 'Refusing to run: ANTHROPIC_API_KEY is not set.' };
  }
  return { ok: true, apiKey };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const FOLLOW_UP_KINDS = ['lead_follow_up', 'proposal_follow_up', 'review_request'] as const;
export const CLAIMS_KINDS = ['claims_ask_filed', 'claims_ask_adjuster_date', 'claims_ask_outcome'] as const;
export type EvalGroup = 'follow_up' | 'claims';

export function groupOf(kind: DraftKind): EvalGroup | null {
  if ((FOLLOW_UP_KINDS as readonly string[]).includes(kind)) return 'follow_up';
  if ((CLAIMS_KINDS as readonly string[]).includes(kind)) return 'claims';
  return null;
}

const jobFactsSchema = z
  .object({
    jobId: z.string().min(1),
    customerFirstName: z.string().min(1),
    companyName: z.string().min(1),
    repFirstName: z.string().min(1).nullable(),
    address: z.string().min(1).nullable(),
    facts: z.record(z.string(), z.string()),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(DRAFT_KINDS),
    facts: jobFactsSchema,
    expectedFacts: z.array(z.string().min(1)).min(1),
  })
  .strict();

const fixtureFileSchema = z.object({ cases: z.array(caseSchema) }).strict();

export type EvalCase = { id: string; kind: DraftKind; facts: JobFacts; expectedFacts: string[] };

/** The JobFacts values a text may cite: the named fields and every fact value. */
export function factValues(f: JobFacts): string[] {
  return [f.customerFirstName, f.companyName, f.repFirstName, f.address, ...Object.values(f.facts)].filter(
    (v): v is string => v !== null,
  );
}

/**
 * Parses and checks the fixture file: 10 cases of each follow-up kind and 20 claims cases, unique
 * ids and job ids, and every expected fact taken from the case's own facts.
 */
export function parseFixtures(raw: unknown): EvalCase[] {
  const { cases } = fixtureFileSchema.parse(raw);
  const problems: string[] = [];
  const ids = new Set<string>();
  const jobIds = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) problems.push(`duplicate case id ${c.id}`);
    ids.add(c.id);
    if (jobIds.has(c.facts.jobId)) problems.push(`duplicate jobId ${c.facts.jobId}`);
    jobIds.add(c.facts.jobId);
    if (!groupOf(c.kind)) problems.push(`${c.id}: kind ${c.kind} is not a follow-up or claims kind`);
    const values = factValues(c.facts);
    for (const e of c.expectedFacts) {
      if (!values.some((v) => v.includes(e))) problems.push(`${c.id}: expected fact "${e}" is not in the case's facts`);
    }
  }
  for (const k of FOLLOW_UP_KINDS) {
    const n = cases.filter((c) => c.kind === k).length;
    if (n !== 10) problems.push(`${k}: ${n} cases, want 10`);
  }
  const claims = cases.filter((c) => groupOf(c.kind) === 'claims').length;
  if (claims !== 20) problems.push(`claims: ${claims} cases, want 20`);
  if (problems.length > 0) throw new Error(`Bad fixtures:\n- ${problems.join('\n- ')}`);
  return cases;
}

// ---------------------------------------------------------------------------
// Fact extractor
// ---------------------------------------------------------------------------

export type FactKind =
  | 'url'
  | 'email'
  | 'phone'
  | 'money'
  | 'date'
  | 'month'
  | 'time'
  | 'weekday'
  | 'relative_day'
  | 'code'
  | 'number'
  | 'name';
export type Fact = { kind: FactKind; raw: string; norm: string };

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n: number): string => String(n).padStart(2, '0');
const monthIndex = (m: string): number => MONTHS.findIndex((full) => full.startsWith(m.toLowerCase().slice(0, 3))) + 1;
const digitsOf = (s: string): string => s.replace(/[^\d.]/g, '').replace(/\.0+$/, '').replace(/\.$/, '');

/**
 * Common words that open a sentence in a short customer text. A capitalised word opening a
 * sentence counts as a name unless it is one of these, so a word missing here is flagged, never
 * missed: the report shows it and the list can grow.
 */
const OPENERS = new Set(
  (
    'a about after again also an and any anything are as at be because before best but by call can cheers check checking ' +
    'come confirm get keep love need see visit want wanted ' +
    'congrats congratulations could did do does drop enjoy feel finally following for from give glad good great had has ' +
    'have hello here hey hi hope hopefully hoping how if in is it its just kindly last leave let lets looking looks may ' +
    'meanwhile might my next no now ok okay on once or our please quick regards remember reply send share should since ' +
    'so sorry sounds still take talk tell text thank thanks that the then there these this those to unfortunately we ' +
    'well were what when whenever where whether which who why will with would yes you your ' +
    // Roofing words that can open a sentence.
    'adjuster appointment claim crew estimate inspection insurance job proposal repair review roof storm work'
  ).split(' '),
);
/** Capitalised words that are never facts. */
const NEVER_FACTS = new Set(['i', "i'm", "i'll", "i've", "i'd", 'stop', 'ok']);

type Pass = { kind: FactKind; re: RegExp; norm: (m: RegExpExecArray) => string; trim?: boolean };

const PASSES: Pass[] = [
  { kind: 'url', re: /\b(?:https?:\/\/|www\.)[^\s]+/gi, norm: (m) => m[0].toLowerCase(), trim: true },
  { kind: 'email', re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, norm: (m) => m[0].toLowerCase() },
  {
    kind: 'phone',
    re: /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}\b/g,
    norm: (m) => m[0].replace(/\D/g, '').slice(-10),
  },
  {
    kind: 'money',
    re: /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?k\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:dollars?|bucks?)\b/gi,
    norm: (m) => {
      const k = /\dk$/i.test(m[0].replace(/\s/g, ''));
      const n = Number(digitsOf(m[0].replace(/k$/i, '')));
      return String(k ? n * 1000 : n);
    },
  },
  {
    kind: 'date',
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    norm: (m) => `${m[2]}-${m[3]}`,
  },
  {
    kind: 'date',
    re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
    norm: (m) => `${pad(monthIndex(m[1]!))}-${pad(Number(m[2]))}`,
  },
  {
    kind: 'date',
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g,
    norm: (m) => `${pad(Number(m[1]))}-${pad(Number(m[2]))}`,
  },
  {
    kind: 'time',
    // The closing dot of "p.m." is left in place: it may end the sentence.
    re: /\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?\s?m\b/gi,
    norm: (m) => {
      let h = Number(m[1]) % 12;
      if (m[3]!.toLowerCase() === 'p') h += 12;
      return `${pad(h)}:${m[2] ?? '00'}`;
    },
  },
  { kind: 'time', re: /\b(\d{1,2}):(\d{2})\b/g, norm: (m) => `${pad(Number(m[1]))}:${m[2]}` },
  { kind: 'time', re: /\b(noon|midnight)\b/gi, norm: (m) => (m[1]!.toLowerCase() === 'noon' ? '12:00' : '00:00') },
  // Capitalised month names on their own; "May" is left out ("May I ask ...").
  { kind: 'month', re: new RegExp(`\\b(${MONTHS.filter((x) => x !== 'may').map((x) => x[0]!.toUpperCase() + x.slice(1)).join('|')})\\b`, 'g'), norm: (m) => m[1]!.toLowerCase() },
  { kind: 'weekday', re: /\b(mon|tues|wednes|thurs|fri|satur|sun)day\b/gi, norm: (m) => m[0].toLowerCase() },
  // "today" and "tonight" are left out: "hope you are well today" states no fact.
  { kind: 'relative_day', re: /\b(tomorrow|yesterday)\b/gi, norm: (m) => m[1]!.toLowerCase() },
  { kind: 'code', re: /\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b|\b[A-Z]{1,6}\d[A-Z0-9]*\b/g, norm: (m) => m[0].toUpperCase() },
  { kind: 'number', re: /\b\d[\d,]*(?:\.\d+)?(?:st|nd|rd|th)?\b/g, norm: (m) => digitsOf(m[0].replace(/(?:st|nd|rd|th)$/, '').replace(/,/g, '')) },
];

function isSentenceStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  return i < 0 || '.!?:\n'.includes(text[i]!);
}

/**
 * Pulls the facts a text states: links, emails, phone numbers, amounts, dates, months, times,
 * weekdays, today/tomorrow, codes (claim numbers), other numbers, and names. Each pass blanks
 * what it matched so later passes do not count it twice. Names are conservative: any capitalised
 * word, except a common word opening a sentence ("Thanks", "We'll") and I, OK and STOP.
 */
export function extractFacts(text: string): Fact[] {
  const out: Fact[] = [];
  let rest = text.replace(/’/g, "'");
  for (const pass of PASSES) {
    pass.re.lastIndex = 0;
    const found: { start: number; raw: string; norm: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = pass.re.exec(rest)) !== null) {
      let raw = m[0];
      if (pass.trim) raw = raw.replace(/[.,!?;:)\]'"]+$/, '');
      const norm = pass.trim ? raw.toLowerCase() : pass.norm(m);
      if (norm !== '') found.push({ start: m.index, raw, norm });
      if (m[0].length === 0) pass.re.lastIndex++;
    }
    for (const f of found) {
      out.push({ kind: pass.kind, raw: f.raw, norm: f.norm });
      rest = rest.slice(0, f.start) + ' '.repeat(f.raw.length) + rest.slice(f.start + f.raw.length);
    }
  }
  const nameRe = /\b[A-Z][A-Za-z']*(?:-[A-Za-z']+)*/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(rest)) !== null) {
    const raw = m[0].replace(/'s$/, '').replace(/'$/, '');
    const norm = raw.toLowerCase();
    if (NEVER_FACTS.has(norm)) continue;
    // Contractions open sentences too: "We'll", "You're", "Haven't".
    if (isSentenceStart(rest, m.index) && OPENERS.has(norm.replace(/'.*$/, ''))) continue;
    out.push({ kind: 'name', raw, norm });
  }
  return out;
}

// ---------------------------------------------------------------------------
// "Only facts in the case"
// ---------------------------------------------------------------------------

export type AllowedFacts = { haystack: string; words: Set<string>; numbers: Set<string>; byKind: Map<FactKind, Set<string>> };

export function allowedFacts(expected: readonly string[]): AllowedFacts {
  const haystack = expected.join('\n').replace(/’/g, "'").toLowerCase();
  const words = new Set(haystack.split(/[^a-z0-9']+/).map((w) => w.replace(/'s$/, '').replace(/'$/, '')).filter((w) => w !== ''));
  const numbers = new Set((haystack.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => digitsOf(n.replace(/,/g, ''))));
  const byKind = new Map<FactKind, Set<string>>();
  for (const e of expected) {
    for (const f of extractFacts(e)) {
      if (!byKind.has(f.kind)) byKind.set(f.kind, new Set());
      byKind.get(f.kind)!.add(f.norm);
    }
  }
  return { haystack, words, numbers, byKind };
}

export function isAllowed(f: Fact, a: AllowedFacts): boolean {
  const has = (kind: FactKind, norm = f.norm): boolean => a.byKind.get(kind)?.has(norm) ?? false;
  switch (f.kind) {
    case 'url':
    case 'email':
      return a.haystack.includes(f.norm);
    case 'code':
      return a.haystack.toUpperCase().includes(f.norm);
    case 'phone':
      return has('phone');
    case 'money':
      return has('money') || a.numbers.has(f.norm);
    case 'date':
      return has('date');
    case 'month': {
      const n = String(MONTHS.indexOf(f.norm) + 1).padStart(2, '0');
      return has('month') || [...(a.byKind.get('date') ?? [])].some((d) => d.startsWith(`${n}-`));
    }
    case 'time':
      return has('time');
    case 'weekday':
    case 'relative_day':
      return a.words.has(f.norm);
    case 'number':
      return a.numbers.has(f.norm);
    case 'name':
      return f.norm.split('-').every((part) => a.words.has(part));
  }
}

/** The facts in `text` that the expected facts do not contain. */
export function unknownFacts(text: string, expected: readonly string[]): Fact[] {
  const a = allowedFacts(expected);
  return extractFacts(text).filter((f) => !isAllowed(f, a));
}

// ---------------------------------------------------------------------------
// Code checks
// ---------------------------------------------------------------------------

export const MAX_TEXT_CHARS = 300;

export type CheckResult = {
  drafted: boolean;
  length: number;
  lengthOk: boolean;
  guardHits: { sentence: string; hits: GuardHit[] }[];
  claimsHits: ClaimsGuardHit[];
  unknownFacts: Fact[];
  pass: boolean;
};

export function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

/** The code checks for one drafted text; `null` (no text came back) fails `drafted`. */
export function checkText(text: string | null, expected: readonly string[]): CheckResult {
  if (text === null) {
    return { drafted: false, length: 0, lengthOk: true, guardHits: [], claimsHits: [], unknownFacts: [], pass: false };
  }
  const guardHits = splitSentences(text)
    .map((sentence) => ({ sentence, hits: guardSentence(sentence, { repName: null }).hits }))
    .filter((g) => g.hits.length > 0);
  const claims = claimsGuard(text);
  const unknown = unknownFacts(text, expected);
  const lengthOk = text.length <= MAX_TEXT_CHARS;
  return {
    drafted: true,
    length: text.length,
    lengthOk,
    guardHits,
    claimsHits: claims.hits,
    unknownFacts: unknown,
    pass: lengthOk && guardHits.length === 0 && claims.ok && unknown.length === 0,
  };
}

export function describeFailures(c: CheckResult): string[] {
  const out: string[] = [];
  if (!c.drafted) out.push('no text (the model refused, the call failed, or the adapter dropped it)');
  if (!c.lengthOk) out.push(`${c.length} characters (most ${MAX_TEXT_CHARS})`);
  for (const g of c.guardHits) out.push(`guardSentence ${g.hits.join('+')}: "${g.sentence}"`);
  if (c.claimsHits.length > 0) out.push(`claimsGuard ${c.claimsHits.join('+')}`);
  if (c.unknownFacts.length > 0) out.push(`facts not in the case: ${c.unknownFacts.map((f) => `${f.raw} (${f.kind})`).join(', ')}`);
  return out;
}

// ---------------------------------------------------------------------------
// Grade answer
// ---------------------------------------------------------------------------

export const GRADE_SCHEMA = {
  type: 'object',
  properties: { grade: { type: 'integer' }, reason: { type: 'string' } },
  required: ['grade', 'reason'],
  additionalProperties: false,
} as const;

const gradeSchema = z.object({ grade: z.number().int().min(1).max(5), reason: z.string().trim().min(1) }).strict();

export type GradeOutcome =
  | { status: 'graded'; grade: number; reason: string }
  | { status: 'refused' }
  | { status: 'error'; error: string };

export type GradeMessage = { stop_reason: string | null; content: readonly { type: string; text?: string }[] };

/** Reads the grader's answer: the stop reason first, then the JSON text block. */
export function parseGrade(res: GradeMessage): GradeOutcome {
  if (res.stop_reason === 'refusal') return { status: 'refused' };
  if (res.stop_reason === 'max_tokens') return { status: 'error', error: 'the grade hit max_tokens' };
  if (res.stop_reason !== 'end_turn' && res.stop_reason !== 'stop_sequence') {
    return { status: 'error', error: `unexpected stop reason ${res.stop_reason ?? 'none'}` };
  }
  const block = res.content.find((b) => b.type === 'text');
  if (!block || typeof block.text !== 'string') return { status: 'error', error: 'the grade had no text' };
  let json: unknown;
  try {
    json = JSON.parse(block.text);
  } catch {
    return { status: 'error', error: 'the grade was not JSON' };
  }
  const parsed = gradeSchema.safeParse(json);
  if (!parsed.success) return { status: 'error', error: 'the grade did not have a 1-5 grade and a reason' };
  return { status: 'graded', grade: parsed.data.grade, reason: parsed.data.reason };
}

export const GRADE_SYSTEM_PROMPT: string = [
  'You grade one short text message that a roofing company will send to its customer.',
  'You get the kind of message, what that kind should do, the facts the writer had, and the text.',
  'Grade how plain and polite the text is and whether it does what the kind asks, from 1 to 5:',
  '5 = plain, polite, clear and does the job; 4 = good with a small flaw; 3 = usable but stiff, wordy or vague;',
  '2 = unclear, pushy or partly off task; 1 = rude, confusing or wrong.',
  'Give the reason in one sentence.',
].join('\n');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type CaseResult = {
  id: string;
  kind: DraftKind;
  text: string | null;
  draftRefused: boolean;
  draftError: string | null;
  checks: CheckResult;
  grade: GradeOutcome | null;
  draftUsage: TurnUsage | null;
  gradeUsage: Tokens | null;
  /** Texts the adapter wrote but did not use, and why. */
  dropped?: { jobId: string; reason: DraftDropReason }[];
};

export type RunReport = {
  startedAt: Date;
  finishedAt: Date;
  draftModel: string;
  gradeModel: string;
  estimate: CostEstimate;
  cases: CaseResult[];
};

export type Totals = {
  cases: number;
  checksPassed: number;
  checksFailed: number;
  graded: number;
  meanGrade: number | null;
  meanGradeByGroup: Record<EvalGroup, number | null>;
  gradeRefused: number;
  gradeErrors: number;
  draftTokens: Tokens;
  gradeTokens: Tokens;
  draftCost: number | null;
  gradeCost: number | null;
};

const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);

export function totals(r: RunReport): Totals {
  const graded = r.cases.flatMap((c) => (c.grade?.status === 'graded' ? [{ kind: c.kind, grade: c.grade.grade }] : []));
  const draftTokens: Tokens = { input: 0, cachedRead: 0, output: 0 };
  const gradeTokens: Tokens = { input: 0, cachedRead: 0, output: 0 };
  for (const c of r.cases) {
    if (c.draftUsage) {
      draftTokens.input += c.draftUsage.inputTokens;
      draftTokens.cachedRead += c.draftUsage.cachedTokens;
      draftTokens.output += c.draftUsage.outputTokens;
    }
    if (c.gradeUsage) {
      gradeTokens.input += c.gradeUsage.input;
      gradeTokens.cachedRead += c.gradeUsage.cachedRead;
      gradeTokens.output += c.gradeUsage.output;
    }
  }
  const byGroup = (g: EvalGroup): number | null => mean(graded.filter((x) => groupOf(x.kind) === g).map((x) => x.grade));
  const passed = r.cases.filter((c) => c.checks.pass).length;
  return {
    cases: r.cases.length,
    checksPassed: passed,
    checksFailed: r.cases.length - passed,
    graded: graded.length,
    meanGrade: mean(graded.map((x) => x.grade)),
    meanGradeByGroup: { follow_up: byGroup('follow_up'), claims: byGroup('claims') },
    gradeRefused: r.cases.filter((c) => c.grade?.status === 'refused').length,
    gradeErrors: r.cases.filter((c) => c.grade?.status === 'error').length,
    draftTokens,
    gradeTokens,
    draftCost: costOf(draftTokens, r.draftModel),
    gradeCost: costOf(gradeTokens, r.gradeModel),
  };
}

/** One markdown table cell: no pipes or line breaks. */
export function cell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const fmtMean = (n: number | null): string => (n === null ? 'n/a' : n.toFixed(2));
const fmtCost = (n: number | null): string => (n === null ? 'n/a (no price)' : formatUsd(n));
const fmtTokens = (t: Tokens): string => `${t.input} in, ${t.cachedRead} cached, ${t.output} out`;

export function gradeCell(g: GradeOutcome | null): { grade: string; reason: string } {
  if (g === null) return { grade: '-', reason: 'not graded (no text)' };
  if (g.status === 'refused') return { grade: 'refused', reason: 'the grader refused' };
  if (g.status === 'error') return { grade: 'error', reason: g.error };
  return { grade: String(g.grade), reason: g.reason };
}

export function renderReport(r: RunReport): string {
  const t = totals(r);
  const actual = t.draftCost === null || t.gradeCost === null ? null : t.draftCost + t.gradeCost;
  const lines: string[] = [
    `# Agent-text eval, ${r.startedAt.toISOString()}`,
    '',
    `Drafts: \`${r.draftModel}\` through the Llm seam's Anthropic adapter (draftTexts, one case per call). Grades: \`${r.gradeModel}\`.`,
    `Run took ${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)} s.`,
    '',
    '## Totals',
    '',
    '| | |',
    '|---|---|',
    `| Cases | ${t.cases} |`,
    `| Code checks passed | ${t.checksPassed} |`,
    `| Code checks failed | ${t.checksFailed} |`,
    `| Graded | ${t.graded} (refused ${t.gradeRefused}, errors ${t.gradeErrors}) |`,
    `| Mean grade | ${fmtMean(t.meanGrade)} (follow-up ${fmtMean(t.meanGradeByGroup.follow_up)}, claims ${fmtMean(t.meanGradeByGroup.claims)}) |`,
    `| Draft tokens | ${fmtTokens(t.draftTokens)} |`,
    `| Grade tokens | ${fmtTokens(t.gradeTokens)} |`,
    `| Actual cost | ${fmtCost(actual)} (drafts ${fmtCost(t.draftCost)}, grades ${fmtCost(t.gradeCost)}) |`,
    `| Estimated cost | about ${formatUsd(r.estimate.typical)}, at most ${formatUsd(r.estimate.ceiling)} |`,
    '',
    'The adapter reports uncached input, cache reads and output; it does not report cache writes, so the actual cost leaves out any cache-write premium. Failed calls report no usage.',
    '',
    '## Cases',
    '',
    '| Case | Kind | Checks | Grade | Reason | Text |',
    '|---|---|---|---|---|---|',
  ];
  for (const c of r.cases) {
    const g = gradeCell(c.grade);
    const checks = c.checks.pass ? 'pass' : `FAIL: ${describeFailures(c.checks).join('; ')}`;
    const text = c.text ?? (c.draftError ? `(error: ${c.draftError})` : c.draftRefused ? '(refused)' : '(none)');
    lines.push(`| ${cell(c.id)} | ${c.kind} | ${cell(checks)} | ${g.grade} | ${cell(g.reason)} | ${cell(text)} |`);
  }
  const failed = r.cases.filter((c) => !c.checks.pass);
  const withDrops = r.cases.filter((c) => (c.dropped?.length ?? 0) > 0);
  if (withDrops.length > 0) {
    lines.push('', '## Dropped by the adapter', '');
    for (const c of withDrops) {
      lines.push(`- **${c.id}** (${c.kind})`);
      for (const d of c.dropped ?? []) lines.push(`  - dropped: ${d.jobId} (${d.reason})`);
    }
  }
  lines.push('', '## Failed code checks', '');
  if (failed.length === 0) lines.push('None.');
  for (const c of failed) {
    lines.push(`- **${c.id}** (${c.kind}): ${describeFailures(c.checks).join('; ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function summaryLine(r: RunReport): string {
  const t = totals(r);
  const actual = t.draftCost === null || t.gradeCost === null ? null : t.draftCost + t.gradeCost;
  return (
    `${t.checksPassed}/${t.cases} passed the code checks; mean grade ${fmtMean(t.meanGrade)} ` +
    `(${t.graded} graded, ${t.gradeRefused} refused, ${t.gradeErrors} errors); actual cost ${fmtCost(actual)}.`
  );
}

/** `agent-texts-2026-10-12T13-40-05Z.md`: sortable and safe in a file name. */
export function reportFileName(d: Date): string {
  return `agent-texts-${d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.md`;
}
