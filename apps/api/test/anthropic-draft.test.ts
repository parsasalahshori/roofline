import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { buildClients } from '../src/providers/anthropic/client.ts';
import { createDraftTexts, DRAFT_SCHEMA } from '../src/providers/anthropic/draft-texts.ts';
import { DRAFT_INSTRUCTIONS, DRAFT_SYSTEM_PROMPT } from '../src/providers/anthropic/draft-prompts.ts';
import { LlmUnavailableError, type JobFacts } from '../src/providers/llm.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/anthropic/${n}`, import.meta.url), 'utf8');
const KEY = 'sk-ant-test-fake';
const config = {
  ANTHROPIC_API_KEY: KEY,
  FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
  FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
  AGENT_DRAFT_MODEL: 'claude-opus-5-5',
  AGENT_EXTRACT_MODEL: 'claude-haiku-5-5',
} as unknown as Config;

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Rec = { url: string; headers: Headers; body: Body };
function fakeFetch(respond: (body: Body) => Response) {
  const calls: Rec[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), headers: new Headers(init?.headers), body });
    return respond(body);
  }) as typeof fetch;
  return { f, calls };
}
const json = (name: string) => () =>
  new Response(fx(name), { status: 200, headers: { 'content-type': 'application/json' } });
const job = (jobId: string): JobFacts => ({
  jobId,
  customerFirstName: 'Dana',
  companyName: 'Test Roofing',
  repFirstName: 'Sam',
  address: null,
  facts: {},
});
async function run(respond: (b: Body) => Response, ids: string[]) {
  const { f, calls } = fakeFetch(respond);
  const c = buildClients(config, f)!;
  const p = createDraftTexts(c)({ instruction: 'claims_ask_filed', facts: ids.map(job) });
  return { p, calls };
}

describe('anthropic draftTexts', () => {
  it('request body: model, effort, schema, fallbacks, two cached system blocks, every jobId', async () => {
    const { p, calls } = await run(json('draft-response.json'), ['j1', 'j2']);
    await p;
    const r = calls[0]!;
    expect(r.url).toContain('/v1/messages');
    expect(r.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const b = r.body;
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.output_config.effort).toBe('low');
    expect(b.output_config.format.type).toBe('json_schema');
    expect(b.output_config.format.schema).toEqual(DRAFT_SCHEMA);
    expect(b.fallbacks).toBe('default');
    expect(b.max_tokens).toBeGreaterThanOrEqual(4000);
    expect(b.system).toHaveLength(2);
    for (const s of b.system) expect(s.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(b.system[0].text).toBe(DRAFT_SYSTEM_PROMPT);
    expect(b.system[1].text).toBe(DRAFT_INSTRUCTIONS.claims_ask_filed);
    const user = JSON.stringify(b.messages[0].content);
    expect(user).toContain('j1');
    expect(user).toContain('j2');
  });

  it('returns the texts and maps usage from the response', async () => {
    const { p } = await run(json('draft-response.json'), ['j1', 'j2']);
    const out = await p;
    expect(out.refused).toBe(false);
    expect(out.texts.map((t) => t.jobId)).toEqual(['j1', 'j2']);
    expect(out.usage.model).toBe('claude-opus-5-5');
    expect(out.usage.inputTokens).toBe(300);
    expect(out.usage.cachedTokens).toBe(250);
    expect(out.usage.outputTokens).toBe(80);
  });

  it('26 facts rejects with RangeError and makes no request', async () => {
    const { p, calls } = await run(json('draft-response.json'), Array.from({ length: 26 }, (_, i) => `j${i}`));
    await expect(p).rejects.toBeInstanceOf(RangeError);
    expect(calls.length).toBe(0);
  });

  it('0 facts returns no texts and makes no request', async () => {
    const { p, calls } = await run(json('draft-response.json'), []);
    const out = await p;
    expect(out.texts).toEqual([]);
    expect(out.refused).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('drops guard-failing, unknown-job, 400-character and duplicate texts', async () => {
    const { p } = await run(json('draft-mixed-response.json'), ['j1', 'j2', 'j3']);
    const out = await p;
    expect(out.refused).toBe(false);
    expect(out.texts).toEqual([
      { jobId: 'j1', body: 'Hi Dana, it is Sam at Test Roofing. Have you filed your insurance claim yet?' },
    ]);
  });

  it('a refusal returns no texts and refused true', async () => {
    const { p } = await run(json('draft-refusal.json'), ['j1']);
    const out = await p;
    expect(out.texts).toEqual([]);
    expect(out.refused).toBe(true);
  });

  it('a 529 on every attempt rejects LlmUnavailableError', async () => {
    const { p } = await run(
      () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }), { status: 529, headers: { 'content-type': 'application/json' } }),
      ['j1'],
    );
    await expect(p).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('a connection error rejects LlmUnavailableError', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const c = buildClients(config, f)!;
    await expect(createDraftTexts(c)({ instruction: 'claims_ask_filed', facts: [job('j1')] })).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('unparseable text and max_tokens reject LlmUnavailableError', async () => {
    const bad = JSON.parse(fx('draft-response.json'));
    bad.content[0].text = 'not json';
    const a = await run(() => new Response(JSON.stringify(bad), { status: 200, headers: { 'content-type': 'application/json' } }), ['j1']);
    await expect(a.p).rejects.toBeInstanceOf(LlmUnavailableError);
    const cut = JSON.parse(fx('draft-response.json'));
    cut.stop_reason = 'max_tokens';
    const b = await run(() => new Response(JSON.stringify(cut), { status: 200, headers: { 'content-type': 'application/json' } }), ['j1']);
    await expect(b.p).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
