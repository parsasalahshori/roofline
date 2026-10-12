import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { buildClients } from '../src/providers/anthropic/client.ts';
import { createAnswer } from '../src/providers/anthropic/answer.ts';
import { SYSTEM_PROMPT } from '../src/providers/anthropic/prompts.ts';
import type { AnswerInput, LlmEvent } from '../src/providers/llm.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/anthropic/${n}`, import.meta.url), 'utf8');
const KEY = 'sk-ant-test-fake';
const config = {
  ANTHROPIC_API_KEY: KEY,
  FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5',
  FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5',
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
const sse = (name: string) => () =>
  new Response(fx(name), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const input = (over: Partial<AnswerInput> = {}): AnswerInput => ({
  companyId: 'co-1',
  companyBlock: 'Company: Test Roofing',
  history: [{ role: 'user', content: 'hello' }],
  tools: ['find_inspection_times'],
  signal: new AbortController().signal,
  ...over,
});
async function run(fixture: string, over: Partial<AnswerInput> = {}, opts?: { fast?: boolean }) {
  const { f, calls } = fakeFetch(sse(fixture));
  const c = buildClients(config, f)!;
  const events: LlmEvent[] = [];
  for await (const e of createAnswer(c, opts)(input(over))) events.push(e);
  return { events, calls };
}
const done = (events: LlmEvent[]) => events.find((e) => e.type === 'done') as Extract<LlmEvent, { type: 'done' }>;

afterEach(() => vi.restoreAllMocks());

describe('anthropic answer adapter', () => {
  it('request body: model claude-opus-5-5, max_tokens 1024, effort low, tool_choice auto, no thinking', async () => {
    const { calls } = await run('answer-text.sse');
    const b = calls[0]!.body;
    expect(b.model).toBe('claude-opus-5-5');
    expect(b.max_tokens).toBe(1024);
    expect(b.output_config.effort).toBe('low');
    expect(b.tool_choice).toEqual({ type: 'auto' });
    expect('thinking' in b).toBe(false);
    expect(['any', 'tool']).not.toContain(b.tool_choice.type);
    expect('speed' in b).toBe(false);
  });

  it('betas header/body contains server-side-fallback-2026-07-01 and fallbacks default', async () => {
    const { calls } = await run('answer-text.sse');
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(calls[0]!.body.fallbacks).toBe('default');
  });

  it('tools are alphabetical, each strict and eager, filtered by i.tools', async () => {
    const { calls } = await run('answer-text.sse', { tools: ['get_hail_forecast', 'find_inspection_times', 'end_call'] as never });
    const tools = calls[0]!.body.tools as { name: string; strict: boolean; eager_input_streaming: boolean }[];
    const names = tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.strict).toBe(true);
      expect(t.eager_input_streaming).toBe(true);
    }
    const only = await run('answer-text.sse', { tools: ['find_inspection_times'] });
    expect((only.calls[0]!.body.tools as { name: string }[]).map((t) => t.name)).toEqual(['find_inspection_times']);
  });

  it('cache breakpoints and a byte-stable prefix across histories', async () => {
    const a = await run('answer-text.sse');
    const b = await run('answer-text.sse', { history: [{ role: 'user', content: 'a different question' }] });
    const s = a.calls[0]!.body.system as { text: string; cache_control: unknown }[];
    expect(s[0]!.text).toBe(SYSTEM_PROMPT);
    expect(s[1]!.text).toBe('Company: Test Roofing');
    for (const x of s) expect(x.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const prefix = (r: Rec) => JSON.stringify([r.body.tools, r.body.system[0]]);
    expect(prefix(a.calls[0]!)).toBe(prefix(b.calls[0]!));
  });

  it('text deltas stream in order and done has end_turn', async () => {
    const { events } = await run('answer-text.sse');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['Sure, ', 'I can help.']);
    expect(done(events).stopReason).toBe('end_turn');
  });

  it('tool input assembled', async () => {
    const { events } = await run('answer-tool-use.sse');
    const tu = events.filter((e) => e.type === 'tool_use');
    expect(tu).toHaveLength(1);
    expect(tu[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_test1',
      name: 'find_inspection_times',
      input: { propertyId: null, address: '1 Test St', fromDate: null, partOfDay: 'any' },
    });
    expect(done(events).stopReason).toBe('tool_use');
  });

  it('refusal: done with refusal and no tool_use', async () => {
    const { events } = await run('answer-refusal.sse');
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
    expect(done(events).stopReason).toBe('refusal');
  });

  it('fallback content blocks are not yielded as text but stay in assistantContent', async () => {
    const { events } = await run('answer-with-fallback-block.sse');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Sure, I can help.');
    const types = done(events).assistantContent.map((b) => (b as { type: string }).type);
    expect(types).toContain('fallback');
    expect(types).toContain('text');
  });

  it('usage mapping', async () => {
    const u = done((await run('answer-text.sse')).events).usage;
    expect(u.inputTokens).toBe(200);
    expect(u.cachedTokens).toBe(150);
    expect(u.outputTokens).toBe(12);
    expect(u.model).toBe('claude-opus-5-5');
  });

  it('fast mode 429 retries once without speed and without the fast-mode beta', async () => {
    const { f, calls } = fakeFetch((body) =>
      body.speed === 'fast'
        ? new Response(fx('rate-limit.json'), { status: 429, headers: { 'content-type': 'application/json' } })
        : sse('answer-text.sse')(),
    );
    const c = buildClients(config, f)!;
    const events: LlmEvent[] = [];
    for await (const e of createAnswer(c, { fast: true })(input())) events.push(e);
    expect(calls[0]!.body.speed).toBe('fast');
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01');
    const last = calls[calls.length - 1]!;
    expect('speed' in last.body).toBe(false);
    expect(last.headers.get('anthropic-beta')).not.toContain('fast-mode-2026-02-01');
    expect(done(events).stopReason).toBe('end_turn');
  });

  it('API key never appears in logs', async () => {
    const spies = (['log', 'error', 'warn'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await run('answer-text.sse');
    await run('answer-refusal.sse');
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(KEY);
  });
});
