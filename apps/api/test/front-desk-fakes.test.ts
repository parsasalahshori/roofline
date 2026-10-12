import { describe, expect, test } from 'vitest';
import { buildDeps } from '../src/deps.ts';
import { InlineJobs } from '../src/jobs/queue.ts';
import { screenCall } from '../src/providers/call-screen.ts';
import { anthropicFor } from '../src/providers/anthropic/index.ts';
import { FakeCallControl } from '../src/providers/fakes/call-control.ts';
import { FakeLineLookup } from '../src/providers/fakes/line-lookup.ts';
import { type Script, ScriptedLlm } from '../src/providers/fakes/scripted-llm.ts';
import { FakeVoiceSession } from '../src/providers/fakes/voice-session.ts';
import { LlmUnavailableError, type LlmEvent, type RouteDecision } from '../src/providers/llm.ts';
import { InlineQueue } from '../src/tasks/queue.ts';
import { makeTestApp, testConfig } from './helpers.ts';

const state = {} as never;
const ROUTE: RouteDecision = { intent: 'status', urgent: false, mood: 'calm', route: 'fast', fastReply: 'Sure.' };
const sub = { accountSid: `AC${'0'.repeat(32)}`, authToken: 'x' };

function routeInput(callerText: string, companyBlock = 'acme') {
  return { companyBlock, state, callerText, channel: 'voice' as const };
}
function answerInput(text: string, opts: { companyBlock?: string; signal?: AbortSignal } = {}) {
  return {
    companyId: 'c1',
    companyBlock: opts.companyBlock ?? 'acme',
    history: [{ role: 'user' as const, content: text }],
    tools: ['lookup_my_jobs' as const],
    signal: opts.signal ?? new AbortController().signal,
  };
}
async function collect(it: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('front desk fakes', () => {
  test('ScriptedLlm routes by the first matching rule and defaults to opus when none matches', async () => {
    const llm = new ScriptedLlm([{ when: /roof/, route: ROUTE }, { when: /roof leak/, route: { ...ROUTE, route: 'end' } }]);
    const sig = new AbortController().signal;
    const hit = await llm.route(routeInput('my roof leaks'), sig);
    expect(hit.route).toBe('fast');
    expect(hit.usage.model).toBe('scripted');
    const miss = await llm.route(routeInput('hello'), sig);
    expect(miss).toMatchObject({ intent: 'unknown', urgent: false, mood: 'calm', route: 'opus', fastReply: null });
  });

  test('ScriptedLlm answers with the default sentence "Sorry, could you say that again?" when no rule matches', async () => {
    const llm = new ScriptedLlm();
    const events = await collect(llm.answer(answerInput('anything')));
    expect(events[0]).toEqual({ type: 'text', text: 'Sorry, could you say that again?' });
    expect(events[events.length - 1]).toMatchObject({ type: 'done', stopReason: 'end_turn' });
  });

  test('ScriptedLlm plays text and tool steps in order and ends with tool_use', async () => {
    const script: Script = [
      {
        when: /jobs/,
        route: ROUTE,
        answer: [
          { kind: 'text', text: 'One moment.' },
          { kind: 'tool', name: 'lookup_my_jobs', input: {} },
          { kind: 'tool', name: 'lookup_my_jobs', input: {}, id: 'tu_x' },
        ],
      },
    ];
    const events = await collect(new ScriptedLlm(script).answer(answerInput('my jobs')));
    expect(events.map((e) => e.type)).toEqual(['text', 'tool_use', 'tool_use', 'done']);
    expect(events[1]).toMatchObject({ id: 'tool_1', name: 'lookup_my_jobs' });
    expect(events[2]).toMatchObject({ id: 'tu_x' });
    const done = events[3];
    expect(done).toMatchObject({ type: 'done', stopReason: 'tool_use' });
    if (done?.type === 'done') expect(done.assistantContent.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
  });

  test('ScriptedLlm refuse step ends with stopReason refusal', async () => {
    const llm = new ScriptedLlm([{ when: /bad/, route: ROUTE, answer: [{ kind: 'refuse' }] }]);
    const events = await collect(llm.answer(answerInput('bad')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'done', stopReason: 'refusal' });
  });

  test('ScriptedLlm records calls with the exact request prefix, identical across two calls of one company', async () => {
    const llm = new ScriptedLlm();
    await collect(llm.answer(answerInput('one')));
    await collect(llm.answer(answerInput('two')));
    await collect(llm.answer(answerInput('one', { companyBlock: 'bolt' })));
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[0]?.prefix).toBe(llm.calls[1]?.prefix);
    expect(llm.calls[2]?.prefix).not.toBe(llm.calls[0]?.prefix);
    expect(llm.calls[0]?.request).not.toHaveProperty('signal');
    llm.reset();
    expect(llm.calls).toEqual([]);
  });

  test('ScriptedLlm failNext(n) fails the next n calls with LlmUnavailableError, then recovers', async () => {
    const llm = new ScriptedLlm();
    const sig = new AbortController().signal;
    llm.failNext(2);
    await expect(llm.route(routeInput('a'), sig)).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(collect(llm.answer(answerInput('a')))).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(llm.route(routeInput('a'), sig)).resolves.toMatchObject({ route: 'opus' });
    expect(llm.calls).toHaveLength(3);
    llm.failNext(1);
    await expect(llm.summarize({ companyBlock: 'x', transcript: 't', actions: [] })).rejects.toBeInstanceOf(LlmUnavailableError);
    const s = await llm.summarize({ companyBlock: 'x', transcript: 't', actions: [] });
    expect(s.summary).toBe('Scripted summary.');
  });

  test('ScriptedLlm delayMs delays the route (use vi.useFakeTimers or a small 20 ms delay and measure >= 15 ms) and honours abort', async () => {
    const llm = new ScriptedLlm();
    llm.delayMs = 20;
    const t0 = Date.now();
    await llm.route(routeInput('x'), new AbortController().signal);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15);

    const ctl = new AbortController();
    const pending = llm.route(routeInput('x'), ctl.signal);
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });

    const ctl2 = new AbortController();
    const gen = collect(llm.answer(answerInput('x', { signal: ctl2.signal })));
    ctl2.abort();
    await expect(gen).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('FakeVoiceSession delivers caller speech and interrupts to the handler and records what is sent', () => {
    const session = new FakeVoiceSession();
    const got: unknown[] = [];
    session.onMessage((m) => got.push(m));
    session.caller.setup({ customParameters: { k: 'v' } });
    session.caller.say('hello');
    session.caller.interrupt('hel');
    session.caller.dtmf('5');
    expect(got).toEqual([
      { type: 'setup', callSid: `CA${'a'.repeat(32)}`, from: '+15555550100', to: '+14025550100', customParameters: { k: 'v' } },
      { type: 'prompt', voicePrompt: 'hello', last: true },
      { type: 'interrupt', utteranceUntilInterrupt: 'hel', durationUntilInterruptMs: 500 },
      { type: 'dtmf', digit: '5' },
    ]);
    session.send({ type: 'play', source: 'x' });
    session.send({ type: 'end', handoffData: '{"reason":"done"}' });
    expect(session.sent).toHaveLength(2);
    expect(session.endedWith).toBe('{"reason":"done"}');
  });

  test('FakeVoiceSession assistantText joins the sent text tokens; close fires onClose once', () => {
    const session = new FakeVoiceSession();
    let closes = 0;
    session.onClose(() => closes++);
    session.send({ type: 'text', token: 'Hi ', last: false });
    session.send({ type: 'play', source: 'x' });
    session.send({ type: 'text', token: 'there.', last: true });
    expect(session.assistantText()).toBe('Hi there.');
    expect(session.caller.assistantText()).toBe('Hi there.');
    session.close();
    session.caller.hangUp();
    session.close();
    expect(session.closed).toBe(true);
    expect(closes).toBe(1);
  });

  test('FakeCallControl stores recordings as bytes, fetches and deletes them, and records calls', async () => {
    const cc = new FakeCallControl();
    const { recordingSid } = await cc.startRecording(sub, 'CA1');
    expect(recordingSid).toMatch(/^RE[0-9a-f]{32}$/);
    expect(await cc.fetchRecording(sub, recordingSid)).toEqual(Uint8Array.from([0x49, 0x44, 0x33]));
    await cc.deleteRecording(sub, recordingSid);
    await cc.deleteRecording(sub, recordingSid);
    await expect(cc.fetchRecording(sub, recordingSid)).rejects.toThrow('recording not found');
    cc.putRecording('REx', Uint8Array.from([1]));
    expect(await cc.fetchRecording(sub, 'REx')).toEqual(Uint8Array.from([1]));
    expect((await cc.placeTestCall({ to: '+1', from: '+2', statusCallback: 'u' })).callSid).toMatch(/^CA[0-9a-f]{32}$/);
    cc.failNext();
    await expect(cc.setVoiceUrl(sub, 'PN1', 'u', 's')).rejects.toThrow('call control failure');
    await expect(cc.setVoiceUrl(sub, 'PN1', 'u', 's')).resolves.toBeUndefined();
    await cc.stopRecording(sub, 'CA1', recordingSid);
    expect(cc.calls.map((c) => c.method)).toEqual([
      'startRecording', 'fetchRecording', 'deleteRecording', 'deleteRecording', 'fetchRecording', 'fetchRecording',
      'placeTestCall', 'setVoiceUrl', 'setVoiceUrl', 'stopRecording',
    ]);
  });

  test('FakeLineLookup answers mobile for +1555, landline for +1556, unknown otherwise', async () => {
    const l = new FakeLineLookup();
    expect(await l.lineType('+15555550100')).toBe('mobile');
    expect(await l.lineType('+15565550100')).toBe('landline');
    expect(await l.lineType('+14025550100')).toBe('unknown');
    expect(l.lookups).toEqual(['+15555550100', '+15565550100', '+14025550100']);
  });

  test('screenCall rejects a blocked number', () => {
    expect(screenCall({ from: '+15555550100', stirVerstat: null, blocked: true, callsLastHour: 99, knownCustomer: false })).toEqual({
      action: 'reject',
      reason: 'blocked_number',
    });
  });

  test('tests and CI never build a real Claude client', async () => {
    const urls = { tenant: 'postgres://x', system: 'postgres://y' };
    const config = testConfig(urls);
    expect(anthropicFor(config)).toBeNull();
    expect(config.ANTHROPIC_API_KEY).toBeUndefined();

    const t = await makeTestApp();
    try {
      expect(t.deps.llm).toBeInstanceOf(ScriptedLlm);
    } finally {
      await t.close();
    }

    const deps = buildDeps(testConfig(urls, { FAKE_PROVIDERS: true, ANTHROPIC_API_KEY: 'sk-ant-test-not-real' }), new InlineQueue(), new InlineJobs());
    try {
      expect(deps.llm).toBeInstanceOf(ScriptedLlm);
      expect(deps.llm.configured).toBe(true);
    } finally {
      await deps.pools.end();
    }
  });
});
