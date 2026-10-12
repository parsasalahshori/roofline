import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { calls, getConversation, insertCall, withTenant, type TenantContext } from '@roofline/db';
import { createEngine, SAY_SPAM_ENDING } from '../../src/front-desk/engine.ts';
import type { ConversationState, EngineEvent, ToolHandlers } from '../../src/front-desk/engine-types.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { AnswerInput, LlmEvent, RouteDecision } from '../../src/providers/llm.ts';
import { makeTestApp, type TestApp } from '../helpers.ts';

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

/** Remembers the abort signal of every answer call, so a test can see that the speculative Opus call was dropped. */
class CapturingLlm extends ScriptedLlm {
  signals: AbortSignal[] = [];
  override answer(i: AnswerInput): AsyncIterable<LlmEvent> {
    this.signals.push(i.signal);
    return super.answer(i);
  }
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function ctxOf(state: ConversationState): TenantContext {
  return { companyId: state.companyId, userId: null, role: 'system', canApproveSpend: false };
}

/** Like setup() in engine.test.ts, plus a real call row so the engine has a callId to mark. */
async function setup(script: Script, tools: ToolHandlers = {}, llm: ScriptedLlm = new ScriptedLlm(script), withCall = true) {
  const t: TestApp = await makeTestApp();
  const deps = { ...t.deps, llm };
  const engine = createEngine(deps, tools);
  let callId: string | undefined;
  if (withCall) {
    const ctx: TenantContext = { companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false };
    const row = await withTenant(t.deps.pools, ctx, (tx) =>
      insertCall(tx, ctx, {
        callSid: `CA${randomUUID().replace(/-/g, '')}`,
        fromE164: '+14025550199',
        toE164: t.seed.a.phoneE164,
        forwardedFrom: null,
        stirVerstat: null,
        now: t.clock.now(),
      }),
    );
    callId = row.id;
  }
  const state = await engine.start({ companyId: t.seed.a.companyId, channel: 'voice', phone: '+14025550199', callId });
  const say = async (text: string) =>
    (await collect(engine.turn(state, text, new AbortController().signal))).filter((e) => e.type !== 'turn_saved');
  return { t, deps, engine, state, llm, say };
}

async function callSpamReason(t: TestApp, state: ConversationState): Promise<string | null | undefined> {
  if (state.callId === null) return undefined;
  const ctx = ctxOf(state);
  const rows = await withTenant(t.deps.pools, ctx, (tx) =>
    tx.select({ spamReason: calls.spamReason }).from(calls).where(eq(calls.id, state.callId!)).limit(1),
  );
  return rows[0]?.spamReason;
}

async function conversationOutcome(t: TestApp, state: ConversationState): Promise<string | null | undefined> {
  const ctx = ctxOf(state);
  const row = await withTenant(t.deps.pools, ctx, (tx) => getConversation(tx, ctx, state.conversationId));
  return row?.outcome;
}

describe('front desk engine: spam calls', () => {
  test('a sales_pitch intent ends politely and marks the conversation spam', async () => {
    const llm = new CapturingLlm([
      {
        when: /warranty/,
        route: { ...OPUS, intent: 'sales_pitch', route: 'opus', fastReply: 'Ignore me' },
        answer: [{ kind: 'text', text: 'Sure, tell me more.' }],
      },
    ]);
    const { t, state, say } = await setup([], {}, llm);
    const events = await say('I am calling about an extended warranty for your roof');
    expect(events).toEqual([
      { type: 'say', text: SAY_SPAM_ENDING },
      { type: 'end', reason: 'spam' },
    ]);
    // The speculative Opus call was started and then dropped before it could speak.
    expect(llm.signals.every((s) => s.aborted)).toBe(true);
    expect(await conversationOutcome(t, state)).toBe('spam');
    expect(await callSpamReason(t, state)).toBe('assistant_spam');
  });

  test('a spam intent with route end ends politely and marks the conversation spam', async () => {
    const { t, state, say } = await setup([
      { when: /first page/, route: { ...OPUS, intent: 'spam', route: 'end', fastReply: null } },
    ]);
    const events = await say('we can get your business on the first page of Google');
    expect(events).toEqual([
      { type: 'say', text: SAY_SPAM_ENDING },
      { type: 'end', reason: 'spam' },
    ]);
    expect(await conversationOutcome(t, state)).toBe('spam');
    expect(await callSpamReason(t, state)).toBe('assistant_spam');
  });

  test('a spam intent wins over a fast reply from the router', async () => {
    const { state, say } = await setup([
      { when: /lead lists/, route: { ...OPUS, intent: 'sales_pitch', route: 'fast', fastReply: 'We can help with leads.' } },
    ]);
    const events = await say('we sell lead lists');
    expect(events.find((e) => e.type === 'say')).toEqual({ type: 'say', text: SAY_SPAM_ENDING });
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'spam' });
    expect(state.history.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: SAY_SPAM_ENDING }] } as unknown as Anthropic.MessageParam);
  });

  test('a call without a callId still ends politely and marks the conversation', async () => {
    const { t, state, say } = await setup(
      [],
      {},
      new ScriptedLlm([{ when: /warranty/, route: { ...OPUS, intent: 'sales_pitch', route: 'opus' } }]),
      false,
    );
    expect(state.callId).toBeNull();
    const events = await say('extended warranty please');
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'spam' });
    expect(await conversationOutcome(t, state)).toBe('spam');
  });

  test('a normal intent is unaffected', async () => {
    const { t, state, say } = await setup([
      { when: /inspection/, route: { ...OPUS, intent: 'schedule_inspection', route: 'opus' }, answer: [{ kind: 'text', text: 'We can book that.' }] },
    ]);
    const events = await say('I need an inspection');
    expect(events.some((e) => e.type === 'end' && (e as { reason: string }).reason === 'spam')).toBe(false);
    expect(events.filter((e) => e.type === 'say')).toEqual([{ type: 'say', text: 'We can book that.' }]);
    expect(await conversationOutcome(t, state)).toBeNull();
    expect(await callSpamReason(t, state)).toBeNull();
  });

  test('end_call tool with reason spam marks the conversation spam', async () => {
    const { t, state, say } = await setup([
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'spam' } }] },
    ]);
    const events = await say('hello, I have a deal for your company');
    expect(events).toContainEqual({ type: 'end', reason: 'spam' });
    expect(events.at(-1)).toEqual({ type: 'end', reason: 'spam' });
    expect(await conversationOutcome(t, state)).toBe('spam');
    expect(await callSpamReason(t, state)).toBe('assistant_spam');
  });

  test('end_call tool with reason goodbye does not mark the conversation spam', async () => {
    const { t, state, say } = await setup([
      { when: /./, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    ]);
    const events = await say('bye');
    expect(events).toContainEqual({ type: 'end', reason: 'goodbye' });
    expect(await conversationOutcome(t, state)).toBeNull();
    expect(await callSpamReason(t, state)).toBeNull();
  });
});
