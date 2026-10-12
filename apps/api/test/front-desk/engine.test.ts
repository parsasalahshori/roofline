import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, test, vi } from 'vitest';
import type { z } from 'zod';
import { getConversation, listTurns, withTenant } from '@roofline/db';
import {
  FRONT_DESK_TOOLS,
  type FrontDeskToolName,
  priceGuardReplacement,
  type TransferReason,
} from '@roofline/shared';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { ConversationState, EngineEvent, ToolHandlers } from '../../src/front-desk/engine-types.ts';
import { appendUser } from '../../src/front-desk/state.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { AnswerInput, LlmEvent, RouteDecision, TurnUsage } from '../../src/providers/llm.ts';
import { type TestApp, makeTestApp } from '../helpers.ts';

// The transfer tool offers exactly the reasons the engine can name, minus model_failure (engine-only).
type Reason = z.infer<typeof FRONT_DESK_TOOLS.transfer_to_person.input>['reason'];
const _eq: [Reason] extends [Exclude<TransferReason, 'model_failure'>]
  ? [Exclude<TransferReason, 'model_failure'>] extends [Reason]
    ? true
    : never
  : never = true;
void _eq;

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
const FAST = (reply: string | null): RouteDecision => ({ ...OPUS, route: 'fast', fastReply: reply });
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

/** Remembers the abort signal of every answer call. */
class CapturingLlm extends ScriptedLlm {
  signals: AbortSignal[] = [];
  override answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    this.signals.push(i.signal);
    return super.answer(i);
  }
}

const FAKE_USAGE: TurnUsage = { model: 'scripted', inputTokens: 100, cachedTokens: 0, outputTokens: 20, firstTokenMs: 1, totalMs: 2 };
const SAY_MAX_TOKENS = 'Sorry — let me put that more simply.';

/** Stops with max_tokens on the first answer call (or on every call), then defers to the script. */
class MaxTokensLlm extends ScriptedLlm {
  private seen = 0;
  constructor(script: Script, private readonly everyCall: boolean) {
    super(script);
  }
  override async *answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    this.seen += 1;
    if (this.everyCall || this.seen === 1) {
      yield { type: 'text', text: 'Partial.' };
      yield { type: 'done', stopReason: 'max_tokens', usage: FAKE_USAGE, assistantContent: [] };
      return;
    }
    yield* super.answer(i);
  }
}

/** Returns the same tool_use on every answer call. */
class LoopToolLlm extends ScriptedLlm {
  private seq = 0;
  constructor(private readonly toolName: FrontDeskToolName, private readonly toolInput: unknown) {
    super([{ when: /./, route: OPUS }]);
  }
  override async *answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    if (i.signal.aborted) return;
    const id = `loop_${++this.seq}`;
    yield { type: 'tool_use', id, name: this.toolName, input: this.toolInput };
    yield {
      type: 'done',
      stopReason: 'tool_use',
      usage: FAKE_USAGE,
      assistantContent: [{ type: 'tool_use', id, name: this.toolName, input: this.toolInput }] as unknown as Anthropic.ContentBlock[],
    };
  }
}

function toolResults(state: ConversationState): { type: string; content: string; is_error?: boolean }[] {
  return state.history
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content as unknown as { type: string; content: string; is_error?: boolean }[])
    .filter((b) => b.type === 'tool_result');
}

function lastUserIndex(state: ConversationState): number {
  return state.history.map((m) => m.role as string).lastIndexOf('user');
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

async function setup(script: Script, tools: ToolHandlers = {}, llm: ScriptedLlm = new ScriptedLlm(script)) {
  const t = await makeTestApp();
  const deps = { ...t.deps, llm };
  const engine = createEngine(deps, tools);
  const state = await engine.start({ companyId: t.seed.a.companyId, channel: 'voice', phone: '+14025550123' });
  expect(state.companyBlock).not.toContain('Monday: closed');
  const say = (text: string) => collect(engine.turn(state, text, new AbortController().signal));
  return { t, deps, engine, state, llm, say };
}

async function savedTurns(t: TestApp, state: ConversationState) {
  const ctx = { companyId: state.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
  return withTenant(t.deps.pools, ctx, (tx) => listTurns(tx, ctx, state.conversationId));
}

describe('front desk engine', () => {
  test('start stores the company number, or the one it is given', async () => {
    const { t, engine, state } = await setup([]);
    const ctx = { companyId: state.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    const row = await withTenant(t.deps.pools, ctx, (tx) => getConversation(tx, ctx, state.conversationId));
    expect(row?.companyNumberE164).toBe(t.seed.a.phoneE164);
    const other = await engine.start({
      companyId: t.seed.a.companyId,
      channel: 'voice',
      phone: '+14025550124',
      companyNumber: '+14025550100',
    });
    const row2 = await withTenant(t.deps.pools, ctx, (tx) => getConversation(tx, ctx, other.conversationId));
    expect(row2?.companyNumberE164).toBe('+14025550100');
  });

  test('barge-in keeps what the caller heard and history stays well formed', async () => {
    const llm = new CapturingLlm([
      {
        when: /roof/,
        route: OPUS,
        answer: [
          { kind: 'text', text: 'First sentence. ' },
          { kind: 'text', text: 'Second sentence. ' },
        ],
      },
    ]);
    const { engine, state, say } = await setup([], {}, llm);
    const ac = new AbortController();
    for await (const e of engine.turn(state, 'my roof leaks', ac.signal)) {
      if (e.type === 'say') ac.abort();
    }
    const last = state.history[state.history.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toEqual([{ type: 'text', text: 'First sentence.' }]);
    await say('next');
    for (let k = 1; k < state.history.length; k++) {
      const prev = state.history[k - 1]!;
      const cur = state.history[k]!;
      if (cur.role === 'assistant') expect(prev.role).not.toBe('assistant');
      if (cur.role === 'user') expect(prev.role).not.toBe('user');
      if ((cur.role as string) === 'system') expect(prev.role).toBe('user');
    }
    const roles = state.history.map((m) => m.role as string);
    const sys = roles.indexOf('system');
    expect(sys).toBeGreaterThan(0);
    expect(JSON.stringify(state.history[sys - 1]!.content)).toContain('next');
  });

  test('fast route speaks Haiku reply and aborts the speculative Opus call', async () => {
    const llm = new CapturingLlm([
      { when: /hours/, route: FAST('We open at eight.'), answer: [{ kind: 'text', text: 'Opus reply.' }] },
    ]);
    const { say } = await setup([], {}, llm);
    const events = await say('what are your hours');
    expect(events.filter((e) => e.type === 'say')).toEqual([{ type: 'say', text: 'We open at eight.' }]);
    expect(llm.signals).toHaveLength(1);
    expect(llm.signals[0]!.aborted).toBe(true);
  });

  test('opus route streams guarded sentences', async () => {
    const { say } = await setup([
      { when: /roof/, route: OPUS, answer: [{ kind: 'text', text: 'We can come Thursday at ten. Does that work?' }] },
    ]);
    const events = await say('I need my roof looked at');
    expect(events.filter((e) => e.type === 'say')).toEqual([
      { type: 'say', text: 'We can come Thursday at ten.' },
      { type: 'say', text: 'Does that work?' },
    ]);
    expect(events.at(-1)?.type).toBe('turn_saved');
  });

  test('guard replacement is recorded in guard_hits', async () => {
    const { t, state, say } = await setup([
      { when: /cost/, route: OPUS, answer: [{ kind: 'text', text: 'It will cost about five thousand dollars.' }] },
    ]);
    const events = await say('what will it cost');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: priceGuardReplacement(null) });
    const rows = await savedTurns(t, state);
    const assistant = rows.find((r) => r.speaker === 'assistant');
    expect(assistant?.guardHits).toContain('price');
    expect(assistant?.text).toContain(priceGuardReplacement(null));
  });

  test('fast reply is guarded', async () => {
    const { say } = await setup([{ when: /cost/, route: FAST('It will cost about five thousand dollars.') }]);
    const events = await say('what will it cost');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: priceGuardReplacement(null) });
  });

  test('tool loop yields a filler before a slow tool', async () => {
    const order: string[] = [];
    const handler = vi.fn(async () => {
      order.push('handler');
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, forModel: 'You have one job.' };
    });
    const { say } = await setup(
      [{ when: /jobs/, route: OPUS, answer: [{ kind: 'tool', name: 'lookup_my_jobs', input: {} }] }],
      { lookup_my_jobs: handler },
    );
    const events = await say('what jobs do I have');
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('filler')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('filler')).toBeLessThan(kinds.indexOf('say'));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: 'Done.' });
    void order;
  });

  test('unknown id is refused and the handler does not run', async () => {
    const handler = vi.fn(async () => ({ ok: true, forModel: 'Confirmed.' }));
    const { state, say, llm } = await setup(
      [{ when: /confirm/, route: OPUS, answer: [{ kind: 'tool', name: 'confirm_appointment', input: { appointmentId: UUID_A } }] }],
      { confirm_appointment: handler },
    );
    await say('please confirm my visit');
    expect(handler).not.toHaveBeenCalled();
    const results = state.history
      .filter((m) => m.role === 'user' && Array.isArray(m.content))
      .flatMap((m) => m.content as unknown as { type: string; content: string; is_error?: boolean }[])
      .filter((b) => b.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ content: "That isn't one of this caller's records.", is_error: true })]);
    expect(llm.calls.filter((c) => c.kind === 'answer')).toHaveLength(2);
  });

  test('a shown id is allowed', async () => {
    const handler = vi.fn(async () => ({ ok: true, forModel: 'Confirmed.' }));
    const { state, say } = await setup(
      [{ when: /confirm/, route: OPUS, answer: [{ kind: 'tool', name: 'confirm_appointment', input: { appointmentId: UUID_B } }] }],
      { confirm_appointment: handler },
    );
    state.shownIds.add(UUID_B);
    await say('please confirm my visit');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('refusal hands off with model_failure', async () => {
    const { say } = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'refuse' }] }]);
    const events = await say('something odd');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: 'Let me get someone who can help with that.' });
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ type: 'handoff', reason: 'model_failure' });
  });

  test('two model errors hand off', async () => {
    const { say, llm } = await setup([]);
    llm.failNext(4);
    const events = await say('hello there');
    expect(events.find((e) => e.type === 'say')).toEqual({
      type: 'say',
      text: "Sorry, I'm having trouble on my end. Let me get someone for you.",
    });
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ reason: 'model_failure' });
  });

  test('one model error is retried once and the call goes on', async () => {
    const { say, llm } = await setup([{ when: /hello/, route: OPUS, answer: [{ kind: 'text', text: 'Hi there.' }] }]);
    llm.failNext(2); // the router, then the first answer
    const events = await say('hello');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: 'Hi there.' });
    expect(events.some((e) => e.type === 'handoff')).toBe(false);
  });

  test('turn limits end the call at 30 minutes', async () => {
    const { t, say } = await setup([]);
    t.clock.advance(30 * 60_000);
    const events = await say('still there');
    expect(events).toEqual([{ type: 'end', reason: 'limit' }]);
  });

  test('cached prefix is identical across two turns and two calls of a company and differs between companies', async () => {
    const t = await makeTestApp();
    const llm = new ScriptedLlm([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Okay.' }] }]);
    const engine = createEngine({ ...t.deps, llm }, {});
    const callA1 = await engine.start({ companyId: t.seed.a.companyId, channel: 'voice', phone: '+14025550123' });
    const callA2 = await engine.start({ companyId: t.seed.a.companyId, channel: 'voice', phone: '+14025550124' });
    const callB = await engine.start({ companyId: t.seed.b.companyId, channel: 'voice', phone: '+14025550125' });
    const signal = new AbortController().signal;
    await collect(engine.turn(callA1, 'first', signal));
    t.clock.advance(5 * 60_000);
    await collect(engine.turn(callA1, 'second', signal));
    await collect(engine.turn(callA2, 'hello', signal));
    await collect(engine.turn(callB, 'hello', signal));
    const prefixes = llm.calls.filter((c) => c.kind === 'answer').map((c) => c.prefix);
    expect(prefixes).toHaveLength(4);
    expect(prefixes[1]).toBe(prefixes[0]);
    expect(prefixes[2]).toBe(prefixes[0]);
    expect(prefixes[3]).not.toBe(prefixes[0]);
    const req = llm.calls.filter((c) => c.kind === 'answer').map((c) => c.request as { tools: string[]; companyBlock: string });
    expect(JSON.stringify(req[1]!.tools)).toBe(JSON.stringify(req[0]!.tools));
    expect(req[1]!.companyBlock).toBe(req[0]!.companyBlock);
    expect(req[0]!.companyBlock).toBe(callA1.companyBlock);
  });

  test('history is append-only', async () => {
    const { state, say } = await setup([
      { when: /jobs/, route: OPUS, answer: [{ kind: 'text', text: 'Let me look.' }, { kind: 'tool', name: 'lookup_my_jobs', input: {} }] },
      { when: /thanks/, route: OPUS, answer: [{ kind: 'text', text: 'You are welcome.' }] },
    ], { lookup_my_jobs: async () => ({ ok: true, forModel: 'One job.' }) });
    await say('what jobs do I have');
    const before = state.history.map((m) => JSON.stringify(m));
    expect(before.length).toBeGreaterThanOrEqual(3);
    await say('thanks');
    const after = state.history.map((m) => JSON.stringify(m));
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.length).toBeGreaterThan(before.length);
    const assistant = state.history.find((m) => m.role === 'assistant');
    expect(JSON.stringify(assistant?.content)).toContain('lookup_my_jobs');
  });

  test('note appends a system message after a user message', async () => {
    const { engine, state, say } = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Okay.' }] }]);
    appendUser(state, 'hello');
    engine.note(state, 'The caller is in a hurry.');
    expect(state.history.at(-1)).toEqual({ role: 'system', content: 'The caller is in a hurry.' });
    // A note made while the assistant spoke last waits for the next user message.
    state.history.length = 0;
    await say('first');
    const n = state.history.length;
    engine.note(state, 'Keep it short.');
    expect(state.history).toHaveLength(n);
    await say('second');
    const idx = state.history.findIndex((m) => (m as unknown as { role: string }).role === 'system');
    expect(idx).toBeGreaterThan(0);
    expect(state.history[idx - 1]?.role).toBe('user');
  });

  test('interrupted truncates the saved assistant row and leaves history alone', async () => {
    const { t, engine, state, say } = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'One long answer.' }] }]);
    await say('hello');
    const before = JSON.stringify(state.history);
    await engine.interrupted(state, 'One long');
    expect(JSON.stringify(state.history)).toBe(before);
    const rows = await savedTurns(t, state);
    const assistant = rows.find((r) => r.speaker === 'assistant');
    expect(assistant).toMatchObject({ text: 'One long', truncated: true });
  });

  test('max_tokens says a short apology, adds a note after the user message and goes on', async () => {
    const llm = new MaxTokensLlm([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Short answer.' }] }], false);
    const { state, say } = await setup([], {}, llm);
    const events = await say('tell me everything');
    expect(events.filter((e) => e.type === 'say').map((e) => (e as { text: string }).text)).toContain(SAY_MAX_TOKENS);
    const u = lastUserIndex(state);
    expect((state.history[u + 1] as unknown as { role: string }).role).toBe('system');
    expect(events.some((e) => e.type === 'handoff')).toBe(false);
  });

  test('max_tokens twice hands off with model_failure', async () => {
    const llm = new MaxTokensLlm([{ when: /./, route: OPUS }], true);
    const { say } = await setup([], {}, llm);
    const events = await say('tell me everything');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ type: 'handoff', reason: 'model_failure' });
  });

  test('invalid tool input is an error result and the handler does not run', async () => {
    const handler = vi.fn(async () => ({ ok: true, forModel: 'Confirmed.' }));
    const { state, say } = await setup(
      [{ when: /confirm/, route: OPUS, answer: [{ kind: 'tool', name: 'confirm_appointment', input: { appointmentId: 'nope' } }] }],
      { confirm_appointment: handler },
    );
    const events = await say('please confirm my visit');
    expect(handler).not.toHaveBeenCalled();
    expect(toolResults(state)).toEqual([expect.objectContaining({ is_error: true })]);
    expect(events.some((e) => e.type === 'handoff')).toBe(false);
  });

  test('invalid tool input twice hands off with not_understood', async () => {
    const llm = new LoopToolLlm('confirm_appointment', { appointmentId: 'nope' });
    const { say } = await setup([], {}, llm);
    const events = await say('please confirm my visit');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ type: 'handoff', reason: 'not_understood' });
  });

  test('transfer_to_person and end_call finish the turn with their event', async () => {
    const a = await setup([
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'transfer_to_person', input: { reason: 'asked', summary: 'x' } }] },
    ]);
    expect(await a.say('let me talk to someone')).toContainEqual({ type: 'handoff', reason: 'asked', summary: 'x' });
    const b = await setup([
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    ]);
    expect(await b.say('bye')).toContainEqual({ type: 'end', reason: 'goodbye' });
  });

  test('more than four tool rounds hands off with not_understood', async () => {
    const llm = new LoopToolLlm('lookup_my_jobs', {});
    const { say } = await setup([], { lookup_my_jobs: async () => ({ ok: true, forModel: 'One job.' }) }, llm);
    const events = await say('what jobs do I have');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ type: 'handoff', reason: 'not_understood' });
  });

  test('router route transfer hands off and route end says goodbye then ends', async () => {
    const a = await setup([{ when: /person/, route: { ...OPUS, route: 'transfer' } }]);
    expect((await a.say('I want a person')).some((e) => e.type === 'handoff')).toBe(true);
    const b = await setup([{ when: /bye/, route: { ...OPUS, route: 'end', fastReply: 'Bye now.' } }]);
    const events = await b.say('bye');
    const kinds = events.map((e) => e.type);
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: 'Bye now.' });
    expect(kinds.indexOf('say')).toBeLessThan(kinds.indexOf('end'));
    expect(events).toContainEqual({ type: 'end', reason: 'goodbye' });
  });

  test('a router failure alone does not stop Opus from answering', async () => {
    const { say, llm } = await setup([{ when: /hello/, route: OPUS, answer: [{ kind: 'text', text: 'Hi there.' }] }]);
    llm.failNext(1);
    const events = await say('hello');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: 'Hi there.' });
    expect(events.some((e) => e.type === 'handoff')).toBe(false);
  });

  test('three straight model failures trip the circuit breaker for sixty seconds', async () => {
    const { t, deps, say, llm } = await setup([]);
    llm.failNext(3); // router, answer, retry
    const events = await say('hello');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ reason: 'model_failure' });
    expect(deps.relaySessions.isLlmHealthy(t.clock.now())).toBe(false);
    t.clock.advance(61_000);
    expect(deps.relaySessions.isLlmHealthy(t.clock.now())).toBe(true);
  });

  test('after 25 minutes a note offering a person follows the user message', async () => {
    const { t, state, say } = await setup([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Okay.' }] }]);
    t.clock.advance(26 * 60_000);
    await say('hello');
    const u = lastUserIndex(state);
    expect((state.history[u + 1] as unknown as { role: string }).role).toBe('system');
  });

  test('three turns in a row not understood hand off with not_understood', async () => {
    const NOT_UNDERSTOOD: RouteDecision = { ...OPUS, intent: 'not_understood' };
    const { state, say } = await setup([{ when: /./, route: NOT_UNDERSTOOD, answer: [{ kind: 'text', text: 'Could you say that again?' }] }]);
    expect((await say('mumble')).some((e) => e.type === 'handoff')).toBe(false);
    expect((await say('mumble')).some((e) => e.type === 'handoff')).toBe(false);
    expect(state.failedUnderstanding).toBe(2);
    const events = await say('mumble');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ reason: 'not_understood' });
  });

  test('a person-ask intent counts once and hands off as asked', async () => {
    const ASKED: RouteDecision = { ...OPUS, intent: 'ask_for_person', route: 'transfer' };
    const { state, say } = await setup([{ when: /./, route: ASKED }]);
    const events = await say('let me talk to someone');
    expect(state.askedForPersonCount).toBe(1);
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ reason: 'asked' });
  });

  test('a person-ask count only counts on a turn that is itself a person-ask', async () => {
    const ASK: RouteDecision = { ...OPUS, intent: 'ask_for_person', route: 'opus' };
    const answer = [{ kind: 'text' as const, text: 'Okay.' }];
    const { state, say } = await setup([
      { when: /first/, route: ASK, answer },
      { when: /middle/, route: { ...OPUS, intent: 'other', route: 'opus' }, answer },
      { when: /last/, route: ASK, answer },
    ]);
    state.taskInProgress = true;
    expect((await say('first')).some((e) => e.type === 'handoff')).toBe(false);
    expect(state.askedForPersonCount).toBe(1);
    state.taskInProgress = false;
    expect((await say('middle')).some((e) => e.type === 'handoff')).toBe(false);
    expect(state.askedForPersonCount).toBe(1);
    const events = await say('last');
    expect(events.find((e) => e.type === 'handoff')).toMatchObject({ reason: 'asked' });
  });

  test('a clear turn resets the misunderstanding count', async () => {
    const { state, say, llm } = await setup([{ when: /mumble/, route: { ...OPUS, intent: 'not_understood' }, answer: [{ kind: 'text', text: 'Again?' }] }, { when: /roof/, route: OPUS, answer: [{ kind: 'text', text: 'Sure.' }] }]);
    await say('mumble');
    expect(state.failedUnderstanding).toBe(1);
    await say('my roof');
    expect(state.failedUnderstanding).toBe(0);
    void llm;
  });
});
