import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.ts';
import { buildClients } from '../src/providers/anthropic/client.ts';
import { CLAIM_REPLY_SCHEMA, createExtractClaimReply } from '../src/providers/anthropic/extract-claim.ts';
import { LlmRefusedError, LlmUnavailableError } from '../src/providers/llm.ts';

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
const ok = (text: string) => () => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
const withModelJson = (obj: unknown) => {
  const m = JSON.parse(fx('extract-response.json'));
  m.content[0].text = JSON.stringify(obj);
  return JSON.stringify(m);
};
const NOW = new Date('2026-10-12T15:00:00Z');
const TZ = 'America/Chicago';
const REPLY = "It's State Farm, claim 0451-22, adjuster Tuesday 10am";
async function run(respond: () => Response) {
  const { f, calls } = fakeFetch(respond);
  const c = buildClients(config, f)!;
  const p = createExtractClaimReply(c)({ text: REPLY, now: NOW, timeZone: TZ });
  return { p, calls };
}

describe('anthropic extractClaimReply', () => {
  it('request body: model, schema, effort, one cached system block, now and timeZone', async () => {
    const { p, calls } = await run(ok(fx('extract-response.json')));
    await p;
    const b = calls[0]!.body;
    expect(b.model).toBe('claude-haiku-5-5');
    expect(b.output_config.effort).toBe('low');
    expect(b.output_config.format.type).toBe('json_schema');
    expect(b.output_config.format.schema).toEqual(CLAIM_REPLY_SCHEMA);
    expect(b.system).toHaveLength(1);
    expect(b.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    const user = JSON.parse(b.messages[0].content);
    expect(user.now).toBe('2026-10-12T15:00:00.000Z');
    expect(user.timeZone).toBe('America/Chicago');
    expect(user.text).toBe(REPLY);
  });

  it('extracts insurer, claim number and adjuster time, with no decision key', async () => {
    const { p } = await run(ok(fx('extract-response.json')));
    const out = await p;
    expect(out.facts).toEqual({ insurer: 'State Farm', claimNumber: '0451-22', adjusterAt: '2026-10-13T10:00:00-05:00' });
    expect('decision' in out.facts).toBe(false);
    expect(out.usage.model).toBe('claude-haiku-5-5');
    expect(out.usage.inputTokens).toBe(150);
    expect(out.usage.cachedTokens).toBe(100);
    expect(out.usage.outputTokens).toBe(30);
  });

  it('drops an adjuster time a year out and keeps the other fields', async () => {
    const { p } = await run(ok(fx('extract-far-date.json')));
    const out = await p;
    expect(out.facts).toEqual({ insurer: 'State Farm', claimNumber: '0451-22' });
  });

  it('drops a 41-character claim number and an 81-character insurer', async () => {
    const body = withModelJson({ claimNumber: 'c'.repeat(41), insurer: 'i'.repeat(81), adjusterAt: null, decision: 'denied' });
    const { p } = await run(ok(body));
    const out = await p;
    expect(out.facts).toEqual({ decision: 'denied' });
  });

  it('a refusal rejects LlmRefusedError, which is also an LlmUnavailableError', async () => {
    const { p } = await run(ok(fx('extract-refusal.json')));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusedError);
    expect(err).toBeInstanceOf(LlmUnavailableError);
  });

  it('unparseable text rejects LlmUnavailableError', async () => {
    const { p } = await run(ok(fx('extract-garbage.json')));
    await expect(p).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it('an all-null answer gives empty facts', async () => {
    const body = withModelJson({ claimNumber: null, insurer: null, adjusterAt: null, decision: null });
    const { p } = await run(ok(body));
    expect((await p).facts).toEqual({});
  });
});
