import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { DRAFT_KINDS } from '../../apps/api/src/providers/llm.ts';
import { describeSdkError, gradeRequest, gradeText, type GradeClient } from '../eval-agent-texts/grade.ts';
import {
  ArgError,
  CLAIMS_KINDS,
  FOLLOW_UP_KINDS,
  GRADE_SCHEMA,
  PRICES_PER_MTOK,
  TOKEN_ESTIMATE,
  checkText,
  describeEstimate,
  estimateCost,
  extractFacts,
  parseArgs,
  parseFixtures,
  parseGrade,
  preflight,
  renderReport,
  reportFileName,
  unknownFacts,
  type CaseResult,
  type EvalCase,
  type RunReport,
} from '../eval-agent-texts/lib.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureRaw: unknown = JSON.parse(readFileSync(path.join(here, '../eval-fixtures/agent-texts.json'), 'utf8'));

describe('arguments and refusals', () => {
  it('reads --confirm-spend and --only', () => {
    expect(parseArgs([])).toEqual({ confirmSpend: false, only: null });
    expect(parseArgs(['--confirm-spend', '--only', 'lead-01,claims-02', '--only=review-03'])).toEqual({
      confirmSpend: true,
      only: ['lead-01', 'claims-02', 'review-03'],
    });
  });

  it('refuses unknown arguments and an empty --only', () => {
    expect(() => parseArgs(['--yes'])).toThrow(ArgError);
    expect(() => parseArgs(['--only'])).toThrow(ArgError);
    expect(() => parseArgs(['--only='])).toThrow(ArgError);
  });

  it('refuses without --confirm-spend, even with a key', () => {
    const r = preflight({ confirmSpend: false, only: null }, { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/--confirm-spend/);
  });

  it('refuses without ANTHROPIC_API_KEY, and a blank key counts as none', () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const r = preflight({ confirmSpend: true, only: null }, env);
      expect(r).toEqual({ ok: false, message: 'Refusing to run: ANTHROPIC_API_KEY is not set.' });
    }
  });

  it('refuses in CI whatever the flags', () => {
    const r = preflight({ confirmSpend: true, only: null }, { CI: 'true', ANTHROPIC_API_KEY: 'sk-ant-test-not-real' });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/CI/);
  });

  it('passes the key through without putting it in any message', () => {
    const key = 'sk-ant-test-not-real';
    expect(preflight({ confirmSpend: true, only: null }, { ANTHROPIC_API_KEY: key, CI: 'false' })).toEqual({ ok: true, apiKey: key });
    for (const args of [{ confirmSpend: false, only: null }, { confirmSpend: true, only: null }]) {
      const r = preflight(args, { ANTHROPIC_API_KEY: args.confirmSpend ? '' : key });
      expect(JSON.stringify(r)).not.toContain(key);
    }
  });
});

describe('fixtures', () => {
  const cases = parseFixtures(fixtureRaw);

  it('has 10 cases of each follow-up kind and 20 claims cases, all known draft kinds', () => {
    for (const k of FOLLOW_UP_KINDS) expect(cases.filter((c) => c.kind === k)).toHaveLength(10);
    expect(cases.filter((c) => (CLAIMS_KINDS as readonly string[]).includes(c.kind))).toHaveLength(20);
    for (const c of cases) expect(DRAFT_KINDS).toContain(c.kind);
  });

  it('uses invented contact details only (555 numbers, example.test links)', () => {
    const text = JSON.stringify(fixtureRaw);
    for (const phone of text.match(/\(\d{3}\) \d{3}-\d{4}/g) ?? []) expect(phone).toMatch(/^\(555\) 01\d-/);
    for (const url of text.match(/https?:\/\/[^"\s]+/g) ?? []) expect(new URL(url).hostname).toMatch(/\.example\.test$/);
    expect(text).not.toMatch(/@(?!example\.test)[\w-]+\.\w+/);
  });

  it('refuses an expected fact that is not in the case', () => {
    const bad = structuredClone(fixtureRaw) as { cases: EvalCase[] };
    bad.cases[0]!.expectedFacts.push('Saturday, November 7');
    expect(() => parseFixtures(bad)).toThrow(/expected fact "Saturday, November 7"/);
  });

  it('refuses the wrong number of cases and duplicate ids', () => {
    const bad = structuredClone(fixtureRaw) as { cases: EvalCase[] };
    bad.cases[1]!.id = bad.cases[0]!.id;
    bad.cases.pop();
    expect(() => parseFixtures(bad)).toThrow(/duplicate case id[\s\S]*claims: 19 cases, want 20/);
  });

  it('a plain text built from each case passes every code check', () => {
    for (const c of cases) {
      const f = c.facts;
      const from = f.repFirstName ? `${f.repFirstName} at ${f.companyName}` : f.companyName;
      const stop = c.kind === 'review_request' ? ' Reply STOP to opt out.' : '';
      const text = `Hi ${f.customerFirstName}, this is ${from}. Just checking in. Any questions, reply here.${stop}`;
      expect(checkText(text, c.expectedFacts), c.id).toMatchObject({ pass: true });
    }
  });
});

describe('fact extractor', () => {
  it('finds names, dates, times, money, phones, links, codes and numbers', () => {
    const facts = extractFacts(
      'Hi Dana, Marco from Ridgeline Roofing here. Your claim HM-20931 with Harborview Mutual: the adjuster comes Tuesday, October 6 at 3 p.m. ' +
        'Call (555) 010-4400 or see https://reviews.example.test/r/1. The repair is $12,500 for 1137 Wexford Court.',
    );
    const by = (kind: string): string[] => facts.filter((f) => f.kind === kind).map((f) => f.norm);
    expect(by('name')).toEqual(['dana', 'marco', 'ridgeline', 'roofing', 'harborview', 'mutual', 'wexford', 'court']);
    expect(by('date')).toEqual(['10-06']);
    expect(by('weekday')).toEqual(['tuesday']);
    expect(by('time')).toEqual(['15:00']);
    expect(by('phone')).toEqual(['5550104400']);
    expect(by('url')).toEqual(['https://reviews.example.test/r/1']);
    expect(by('money')).toEqual(['12500']);
    expect(by('code')).toEqual(['HM-20931']);
    expect(by('number')).toEqual(['1137']);
  });

  it('leaves sentence openers, I and STOP alone but counts a name opening a sentence before a comma', () => {
    const names = extractFacts('Thanks, Dana! We hope it went well. Selma, did the adjuster come? I can help. Reply STOP to opt out.')
      .filter((f) => f.kind === 'name')
      .map((f) => f.raw);
    expect(names).toEqual(['Dana', 'Selma']);
  });

  it('a "p.m." at the end of a sentence still ends it', () => {
    expect(extractFacts('We come at 3 p.m. Thanks again.').filter((f) => f.kind === 'name')).toEqual([]);
  });

  it('normalises dates and times written different ways to the same fact', () => {
    expect(unknownFacts('See you Oct 6th at 3:00 PM.', ['Tuesday, October 6', '3 p.m.'])).toEqual([]);
    expect(unknownFacts('See you 10/6 at 15:00.', ['October 6', '3 p.m.'])).toEqual([]);
    expect(unknownFacts('That was in October.', ['Tuesday, October 6'])).toEqual([]);
  });

  it('reads $12.5k and 12,500 dollars as 12500', () => {
    expect(extractFacts('About $12.5k').map((f) => f.norm)).toEqual(['12500']);
    expect(extractFacts('12,500 dollars').map((f) => f.norm)).toEqual(['12500']);
  });

  it('flags facts the case does not have', () => {
    const expected = ['Dana', 'Ridgeline Roofing', 'Monday, October 5', 'roof inspection'];
    const unknown = unknownFacts(
      'Hi Dana, Ridgeline Roofing here. Priya can come Thursday, October 8 at 9 a.m. or tomorrow. Call (555) 019-1234 or visit www.example.test. Claim KH-1 is $400.',
      expected,
    );
    expect(unknown.map((f) => `${f.kind}:${f.raw}`)).toEqual([
      'url:www.example.test',
      'phone:(555) 019-1234',
      'money:$400',
      'date:October 8',
      'time:9 a.m',
      'weekday:Thursday',
      'relative_day:tomorrow',
      'code:KH-1',
      'name:Priya',
    ]);
  });

  it('a plain sentence with no names or numbers states no facts', () => {
    expect(extractFacts('Just checking in to see if you still want us to take a look. You may reply any time today.')).toEqual([]);
  });
});

describe('code checks', () => {
  const expected = ['Dana', 'Ridgeline Roofing', 'roof inspection'];

  it('passes a plain text', () => {
    const r = checkText('Hi Dana, this is Ridgeline Roofing. Do you still want the roof inspection? Reply here any time.', expected);
    expect(r).toMatchObject({ drafted: true, lengthOk: true, guardHits: [], claimsHits: [], unknownFacts: [], pass: true });
  });

  it('fails a missing text', () => {
    expect(checkText(null, expected)).toMatchObject({ drafted: false, pass: false });
  });

  it('fails a text over 300 characters', () => {
    const r = checkText(`Hi Dana, ${'thanks again. '.repeat(25)}`, expected);
    expect(r.lengthOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails price words through guardSentence, sentence by sentence', () => {
    const r = checkText('Hi Dana. A new roof costs about 9 dollars a square foot. Thanks!', expected);
    expect(r.guardHits).toEqual([{ sentence: 'A new roof costs about 9 dollars a square foot.', hits: ['price'] }]);
    expect(r.pass).toBe(false);
  });

  it('fails claims language through claimsGuard', () => {
    const r = checkText("Hi Dana, we'll call your insurer for you and we can waive the deductible.", expected);
    expect(r.claimsHits).toEqual(expect.arrayContaining(['deductible', 'insurer_contact']));
    expect(r.pass).toBe(false);
  });

  it('fails invented facts', () => {
    const r = checkText('Hi Dana, Marco from Ridgeline Roofing can come Friday.', expected);
    expect(r.unknownFacts.map((f) => f.raw)).toEqual(['Friday', 'Marco']);
    expect(r.pass).toBe(false);
  });
});

describe('cost estimate', () => {
  it('prices one draft and one grade per case from the one price table', () => {
    const e = estimateCost(50, 'claude-opus-5-5', 'claude-haiku-5-5');
    const opus = PRICES_PER_MTOK['claude-opus-5-5']!;
    const haiku = PRICES_PER_MTOK['claude-haiku-5-5']!;
    const { draft, grade } = TOKEN_ESTIMATE;
    const typical = 50 * ((draft.input * opus.input + draft.output * opus.output + grade.input * haiku.input + grade.output * haiku.output) / 1e6);
    expect(e.typical).toBeCloseTo(typical, 10);
    expect(e.ceiling).toBeGreaterThan(e.typical);
    expect(opus).toMatchObject({ input: 4, output: 20 });
    expect(haiku).toMatchObject({ input: 0.1, output: 0.5 });
    expect(describeEstimate(e, 'claude-opus-5-5', 'claude-haiku-5-5')).toMatch(
      /^Estimated cost: about \$\d+\.\d\d \(at most \$\d+\.\d\d .*50 drafts on claude-opus-5-5 and 50 grades on claude-haiku-5-5\.$/,
    );
  });

  it('refuses a model with no price', () => {
    expect(() => estimateCost(1, 'claude-unknown', 'claude-haiku-5-5')).toThrow(/No price for claude-unknown/);
  });
});

describe('grade answer', () => {
  const msg = (stop_reason: string | null, text?: string) => ({
    stop_reason,
    content: text === undefined ? [] : [{ type: 'text', text }],
  });

  it('reads a grade and a reason', () => {
    expect(parseGrade(msg('end_turn', '{"grade":4,"reason":"Plain and polite."}'))).toEqual({
      status: 'graded',
      grade: 4,
      reason: 'Plain and polite.',
    });
  });

  it('checks the stop reason before the content', () => {
    expect(parseGrade(msg('refusal', '{"grade":5,"reason":"x"}'))).toEqual({ status: 'refused' });
    expect(parseGrade(msg('max_tokens', '{"grade":5,'))).toEqual({ status: 'error', error: 'the grade hit max_tokens' });
    expect(parseGrade(msg('pause_turn', '{"grade":5,"reason":"x"}'))).toMatchObject({ status: 'error' });
  });

  it('refuses a missing, non-JSON or wrongly shaped answer', () => {
    expect(parseGrade(msg('end_turn'))).toMatchObject({ status: 'error', error: 'the grade had no text' });
    expect(parseGrade(msg('end_turn', 'Grade: 4'))).toMatchObject({ error: 'the grade was not JSON' });
    for (const bad of ['{"grade":6,"reason":"x"}', '{"grade":0,"reason":"x"}', '{"grade":3.5,"reason":"x"}', '{"grade":3,"reason":""}', '{"grade":3}', '{"grade":3,"reason":"x","extra":1}']) {
      expect(parseGrade(msg('end_turn', bad)), bad).toMatchObject({ status: 'error' });
    }
  });

  it('asks Haiku with structured output, no thinking settings and no prefill', () => {
    const req = gradeRequest('claude-haiku-5-5', 'lead_follow_up', parseFixtures(fixtureRaw)[0]!.facts, 'Hi Dana.');
    expect(req).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 1024,
      output_config: { format: { type: 'json_schema', schema: GRADE_SCHEMA } },
    });
    expect(req).not.toHaveProperty('thinking');
    expect(req).not.toHaveProperty('output_format');
    expect(req.messages.map((m) => m.role)).toEqual(['user']);
    expect(GRADE_SCHEMA).toMatchObject({ additionalProperties: false, required: ['grade', 'reason'] });
  });

  it('records SDK errors per case, most specific first, and rethrows anything else', async () => {
    const headers = new Headers();
    const facts = parseFixtures(fixtureRaw)[0]!.facts;
    const failing = (err: unknown): GradeClient => ({ messages: { create: () => Promise.reject(err) } });
    const cases: [unknown, string][] = [
      [new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', headers), 'rate limited (429)'],
      [new Anthropic.APIConnectionTimeoutError({ message: 'timeout' }), 'the request timed out'],
      [new Anthropic.APIConnectionError({ message: 'socket hang up' }), 'could not reach the API'],
      [new Anthropic.InternalServerError(500, { type: 'error' }, 'boom', headers), 'API error (500)'],
    ];
    for (const [err, message] of cases) {
      expect(describeSdkError(err)).toBe(message);
      expect(await gradeText(failing(err), 'claude-haiku-5-5', 'lead_follow_up', facts, 'Hi.')).toEqual({
        outcome: { status: 'error', error: message },
        usage: null,
      });
    }
    await expect(gradeText(failing(new TypeError('bug')), 'claude-haiku-5-5', 'lead_follow_up', facts, 'Hi.')).rejects.toThrow('bug');
  });

  it('returns the usage of an answered call', async () => {
    const facts = parseFixtures(fixtureRaw)[0]!.facts;
    const client: GradeClient = {
      messages: {
        create: async () =>
          ({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: '{"grade":5,"reason":"Clear and kind."}' }],
            usage: { input_tokens: 300, cache_read_input_tokens: null, output_tokens: 40 },
          }) as unknown as Anthropic.Message,
      },
    };
    expect(await gradeText(client, 'claude-haiku-5-5', 'lead_follow_up', facts, 'Hi.')).toEqual({
      outcome: { status: 'graded', grade: 5, reason: 'Clear and kind.' },
      usage: { input: 300, cachedRead: 0, output: 40 },
    });
  });
});

describe('report', () => {
  const base = (over: Partial<CaseResult>): CaseResult => ({
    id: 'lead-01',
    kind: 'lead_follow_up',
    text: 'Hi Dana | pipe\nline',
    draftRefused: false,
    draftError: null,
    checks: checkText('Hi Dana.', ['Dana']),
    grade: { status: 'graded', grade: 4, reason: 'Plain.' },
    draftUsage: { model: 'claude-opus-5-5', inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 100_000, firstTokenMs: null, totalMs: 900 },
    gradeUsage: { input: 1_000_000, cachedRead: 0, output: 0 },
    ...over,
  });
  const report: RunReport = {
    startedAt: new Date('2026-10-12T13:40:05.123Z'),
    finishedAt: new Date('2026-10-12T13:41:05.123Z'),
    draftModel: 'claude-opus-5-5',
    gradeModel: 'claude-haiku-5-5',
    estimate: estimateCost(3, 'claude-opus-5-5', 'claude-haiku-5-5'),
    cases: [
      base({}),
      base({ id: 'claims-01', kind: 'claims_ask_filed', text: null, draftError: 'Claude request failed (500)', checks: checkText(null, ['Dana']), grade: null, draftUsage: null, gradeUsage: null }),
      base({ id: 'review-01', kind: 'review_request', checks: checkText('Hi Selma.', ['Dana']), grade: { status: 'refused' } }),
    ],
  };

  it('renders totals, actual cost from usage, each case and the failures', () => {
    const md = renderReport(report);
    expect(md).toContain('# Agent-text eval, 2026-10-12T13:40:05.123Z');
    expect(md).toContain('| Code checks passed | 1 |');
    expect(md).toContain('| Code checks failed | 2 |');
    expect(md).toContain('| Graded | 1 (refused 1, errors 0) |');
    expect(md).toContain('| Mean grade | 4.00 (follow-up 4.00, claims n/a) |');
    // Drafts: 2 x (1M in at $4 + 0.1M out at $20) = $12; grades: 2 x 1M in at $0.10 = $0.20.
    expect(md).toContain('| Actual cost | $12.20 (drafts $12.00, grades $0.20) |');
    expect(md).toContain('| lead-01 | lead_follow_up | pass | 4 | Plain. | Hi Dana \\| pipe line |');
    expect(md).toContain('| claims-01 | claims_ask_filed | FAIL: no text');
    expect(md).toContain('(error: Claude request failed (500))');
    expect(md).toContain('- **review-01** (review_request): facts not in the case: Selma (name)');
  });

  it('prints the adapter drop reasons, and nothing for a case without drops', () => {
    expect(renderReport(report)).not.toContain('dropped:');
    const md = renderReport({ ...report, cases: [base({ dropped: [{ jobId: 'job-1', reason: 'too_long' }] })] });
    expect(md).toContain('dropped: job-1 (too_long)');
  });

  it('names the file by start time', () => {
    expect(reportFileName(report.startedAt)).toBe('agent-texts-2026-10-12T13-40-05Z.md');
  });
});
