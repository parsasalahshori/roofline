import { describe, expect, test, vi } from 'vitest';
import { insertCall, listTurns, withTenant } from '@roofline/db';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { ConversationState, Engine } from '../../src/front-desk/engine-types.ts';
import { type RelayCall, runRelayLoop } from '../../src/front-desk/relay-session-loop.ts';
import { FakeVoiceSession } from '../../src/providers/fakes/voice-session.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../src/providers/llm.ts';
import { makeTestApp } from '../helpers.ts';

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
let CALL_ID = '33333333-3333-4333-8333-333333333333';

async function rig(script: Script, over: Partial<RelayCall> = {}) {
  const t = await makeTestApp();
  const deps = { ...t.deps, llm: new ScriptedLlm(script) };
  const inner = createEngine(deps, {});
  let state: ConversationState | null = null;
  const engine: Engine = {
    ...inner,
    start: async (i) => {
      state = await inner.start(i);
      return state;
    },
  };
  const sysCtx = { companyId: t.seed.a.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
  const callRow = await withTenant(t.deps.pools, sysCtx, (tx) =>
    insertCall(tx, sysCtx, { callSid: `CA${'b'.repeat(32)}`, fromE164: '+15555550100', toE164: '+14025550100', forwardedFrom: null, stirVerstat: null, now: t.clock.now() }),
  );
  CALL_ID = callRow.id;
  const call: RelayCall = {
    callId: CALL_ID,
    companyId: t.seed.a.companyId,
    callSid: `CA${'b'.repeat(32)}`,
    from: '+15555550100',
    to: '+14025550100',
    messageOnly: false,
    ...over,
  };
  const session = new FakeVoiceSession();
  const loop = runRelayLoop(session, { deps, engine, call });
  const rows = async () => {
    const ctx = { companyId: call.companyId, userId: null, role: 'system' as const, canApproveSpend: false };
    return withTenant(t.deps.pools, ctx, (tx) => listTurns(tx, ctx, state!.conversationId));
  };
  return { session, loop, rows, call };
}

const SAY = [{ when: /./, route: OPUS, answer: [{ kind: 'text' as const, text: 'We can help with that.' }] }];
const TRANSFER = [
  { when: /./, route: OPUS, answer: [{ kind: 'tool' as const, name: 'transfer_to_person' as const, input: { reason: 'asked', summary: 'x' } }] },
];

describe('relay session loop', () => {
  test('setup then prompt streams text tokens and the last marker', async () => {
    const { session, loop } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.caller.say('hello there');
    await loop.settled();
    const texts = session.sent.filter((m) => m.type === 'text');
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.at(-1)).toMatchObject({ token: '', last: true });
    expect(session.assistantText()).toContain('We can help with that.');
  });

  test('a partial prompt (last false) starts no turn', async () => {
    const { session, loop } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.deliver({ type: 'prompt', voicePrompt: 'hel', last: false });
    await loop.settled();
    expect(session.sent).toEqual([]);
  });

  test('a handoff event sends an end with handoffData kind transfer and still saves the turn row', async () => {
    const { session, loop, rows } = await rig(TRANSFER);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.caller.say('let me talk to someone');
    await loop.settled();
    expect(loop.ended).toBe(true);
    expect(JSON.parse(session.endedWith!)).toMatchObject({ kind: 'transfer', reason: 'asked', summary: 'x' });
    expect(session.sent.at(-1)?.type).toBe('end');
    expect((await rows()).some((r) => r.speaker === 'assistant')).toBe(true);
  });

  test('setup with a callId that differs from the call closes the session', async () => {
    const { session, loop } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: '44444444-4444-4444-8444-444444444444' } });
    await loop.settled();
    expect(session.closed).toBe(true);
  });

  test('interrupt aborts the turn and records truncation', async () => {
    const { session, loop, rows } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.caller.say('hello there');
    await loop.settled();
    session.caller.interrupt('We can');
    await loop.settled();
    const assistant = (await rows()).find((r) => r.speaker === 'assistant');
    expect(assistant).toMatchObject({ text: 'We can', truncated: true });
  });

  test('dtmf 0 sends an end with a transfer request', async () => {
    const { session, loop } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.caller.dtmf('5');
    await loop.settled();
    expect(session.endedWith).toBeNull();
    session.caller.dtmf('0');
    await loop.settled();
    expect(JSON.parse(session.endedWith!)).toEqual({ kind: 'transfer', reason: 'asked', summary: '' });
    expect(loop.ended).toBe(true);
  });

  test('message-only mode sends kind end for a handoff', async () => {
    const { session, loop } = await rig(TRANSFER, { messageOnly: true });
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.caller.say('let me talk to someone');
    await loop.settled();
    expect(JSON.parse(session.endedWith!).kind).toBe('end');
  });

  test('logs carry no transcript text', async () => {
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    const { session, loop } = await rig(SAY);
    session.caller.setup({ customParameters: { callId: CALL_ID } });
    session.deliver({ type: 'error', description: 'boom' });
    session.caller.say('my secret sentence zebra');
    await loop.settled();
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain('zebra');
    spies.forEach((s) => s.mockRestore());
  });
});
