import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { LlmUnavailableError } from '../src/providers/llm.ts';
import { buildClients } from '../src/providers/anthropic/client.ts';
import { createRoute } from '../src/providers/anthropic/route.ts';
import { createSummarize } from '../src/providers/anthropic/summarize.ts';

const KEY = 'sk-ant-test-fake';
const config = { ANTHROPIC_API_KEY: KEY, FRONT_DESK_ROUTER_MODEL: 'claude-haiku-5-5', FRONT_DESK_ANSWER_MODEL: 'claude-opus-5-5' } as unknown as Config;
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/anthropic/${name}.json`, import.meta.url), 'utf8');

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
function fakeFetch(respond: () => Response) {
  const bodies: Body[] = [];
  const f = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Body);
    return respond();
  }) as unknown as typeof fetch;
  return { f, bodies };
}
const ok = (name: string) => () => new Response(fixture(name), { status: 200, headers: { 'content-type': 'application/json' } });
const routeInput = { companyBlock: 'Company: Acme Roofing', state: {} as never, callerText: 'I need an inspection', channel: 'voice' as const };
const signal = () => new AbortController().signal;

describe('anthropic route/summarize', () => {
  it('route request body: model claude-haiku-5-5, max_tokens 300, output_config.effort low, json_schema, no thinking, no tool_choice, two cached system blocks', async () => {
    const { f, bodies } = fakeFetch(ok('route-response'));
    const route = createRoute(buildClients(config, f)!);
    await route(routeInput, signal());
    const b = bodies[0]!;
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.max_tokens).toBe(300);
    expect(b.output_config.effort).toBe('low');
    expect(b.output_config.format.type).toBe('json_schema');
    expect(b.output_config.format.schema.additionalProperties).toBe(false);
    expect(b.thinking).toBeUndefined();
    expect(b.tool_choice).toBeUndefined();
    expect(b.system).toHaveLength(2);
    for (const s of b.system) expect(s.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('route returns the parsed decision and usage mapping', async () => {
    const { f } = fakeFetch(ok('route-response'));
    const r = await createRoute(buildClients(config, f)!)(routeInput, signal());
    expect(r).toMatchObject({ intent: 'book inspection', urgent: false, mood: 'calm', route: 'opus', fastReply: null });
    expect(r.usage).toMatchObject({ model: 'claude-haiku-5-5', cachedTokens: 100, inputTokens: 120, outputTokens: 30, firstTokenMs: null });
  });

  it('route: invalid JSON from the model throws LlmUnavailableError', async () => {
    const bad = JSON.parse(fixture('route-response')) as Body;
    bad.content[0].text = 'not json';
    const { f } = fakeFetch(() => new Response(JSON.stringify(bad), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(createRoute(buildClients(config, f)!)(routeInput, signal())).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('route: a 429 response throws LlmUnavailableError', async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } }));
    await expect(createRoute(buildClients(config, f)!)(routeInput, signal())).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('route schema has none of minLength, maxLength, minimum, maximum, multipleOf, pattern', async () => {
    const { f, bodies } = fakeFetch(ok('route-response'));
    await createRoute(buildClients(config, f)!)(routeInput, signal());
    expect(JSON.stringify(bodies[0]!.output_config.format.schema)).not.toMatch(/minLength|maxLength|minimum|maximum|multipleOf|pattern/);
  });

  it('summarize request: model claude-haiku-5-5, max_tokens 800, output_config.format present; returns summary/outcome/followUps', async () => {
    const { f, bodies } = fakeFetch(ok('summarize-response'));
    const r = await createSummarize(buildClients(config, f)!)({ companyBlock: 'Company: Acme Roofing', transcript: 'Caller: hi', actions: ['booked'] });
    const b = bodies[0]!;
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.max_tokens).toBe(800);
    expect(b.output_config.format.type).toBe('json_schema');
    expect(JSON.stringify(b.output_config.format.schema)).not.toMatch(/minLength|maxLength|minimum|maximum|multipleOf|pattern/);
    expect(r).toMatchObject({ summary: 'Caller booked an inspection.', outcome: 'booked', followUps: ['Confirm by text'] });
  });

  it('the API key never appears in thrown error messages', async () => {
    const { f } = fakeFetch(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const err = await createRoute(buildClients(config, f)!)(routeInput, signal()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(KEY);
  });
});
