import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { companySettings, findCallRecordingBySid, insertCall, listTurns, withTenant, type TenantContext } from '@roofline/db';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { ConversationState, Engine } from '../../src/front-desk/engine-types.ts';
import { createRecording, isRecordingObjection } from '../../src/front-desk/recording.ts';
import { runRelayLoop, type RelayCall } from '../../src/front-desk/relay-session-loop.ts';
import { FakeVoiceSession } from '../../src/providers/fakes/voice-session.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../src/providers/llm.ts';
import { makeTestApp } from '../helpers.ts';

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };
const SAY: Script = [{ when: /./, route: OPUS, answer: [{ kind: 'text' as const, text: 'Of course.' }] }];
const SID = `CA${'c'.repeat(32)}`;

describe('isRecordingObjection', () => {
  test.each([
    "please don't record this",
    'Do not record me',
    'stop recording',
    'can you stop the recording',
    'no recording please',
    'turn off the recording',
    "I don't want to be recorded",
    "I don't want this recorded",
  ])('matches %s', (text) => {
    expect(isRecordingObjection(text)).toBe(true);
  });
  test.each(['record my address', 'my roof leaks', 'I want a record of the quote', ''])('does not match %s', (text) => {
    expect(isRecordingObjection(text)).toBe(false);
  });
});

async function rig(script: Script = SAY) {
  const t = await makeTestApp();
  const deps = { ...t.deps, llm: new ScriptedLlm(script) };
  const ctx: TenantContext = { companyId: t.seed.a.companyId, userId: null, role: 'system', canApproveSpend: false };
  const row = await withTenant(t.deps.pools, ctx, (tx) =>
    insertCall(tx, ctx, { callSid: SID, fromE164: '+15555550100', toE164: '+14025550100', forwardedFrom: null, stirVerstat: null, now: t.clock.now() }),
  );
  const call = { callId: row.id, companyId: ctx.companyId, callSid: SID };
  const status = async () => {
    const r = await withTenant(t.deps.pools, ctx, (tx) => findCallRecordingBySid(tx, ctx, SID));
    return { recording_status: r!.recordingStatus, transcript_stored: r!.transcriptStored };
  };
  return { t, deps, ctx, call, status };
}

describe('call recording', () => {
  test('starts once', async () => {
    const { deps, call, t, status } = await rig();
    const rec = createRecording(deps, call);
    await rec.start();
    await rec.start();
    expect(t.callControl.calls.filter((c) => c.method === 'startRecording')).toHaveLength(1);
    expect((await status()).recording_status).toBe('recording');
  });

  test('retention 0 never records', async () => {
    const { deps, call, t, ctx } = await rig();
    await withTenant(t.deps.pools, ctx, (tx) =>
      tx.update(companySettings).set({ recordingRetentionDays: 0 }).where(eq(companySettings.companyId, ctx.companyId)),
    );
    await createRecording(deps, call).start();
    expect(t.callControl.calls.filter((c) => c.method === 'startRecording')).toHaveLength(0);
  });

  test('objection stops recording and the transcript', async () => {
    const { deps, call, t, status } = await rig();
    const rec = createRecording(deps, call);
    await rec.start();
    await rec.stopForObjection();
    await rec.stopForObjection();
    expect(rec.objected).toBe(true);
    expect(t.callControl.calls.filter((c) => c.method === 'stopRecording')).toHaveLength(1);
    const s = await status();
    expect(s.recording_status).toBe('stopped_by_caller');
    expect(s.transcript_stored).toBe(false);
  });

  test('a caller objection in the relay loop stores blank turns and a system turn', async () => {
    const { deps, call, t, ctx } = await rig();
    const inner = createEngine(deps, {});
    let state: ConversationState | null = null;
    const engine: Engine = {
      ...inner,
      start: async (i) => {
        state = await inner.start(i);
        return state;
      },
    };
    const relayCall: RelayCall = { ...call, from: '+15555550100', to: '+14025550100', messageOnly: false };
    const session = new FakeVoiceSession();
    const recording = createRecording(deps, call);
    await recording.start();
    const loop = runRelayLoop(session, { deps, engine, call: relayCall, recording });
    session.caller.setup({ customParameters: { callId: call.callId } });
    session.caller.say('please stop recording');
    await loop.settled();
    const turns = await withTenant(t.deps.pools, ctx, (tx) => listTurns(tx, ctx, state!.conversationId));
    const system = turns.filter((x) => x.speaker === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toBe("Recording and transcript stopped at the caller's request");
    for (const turn of turns.filter((x) => x.speaker === 'caller' || x.speaker === 'assistant')) expect(turn.text).toBe('');
    expect(t.callControl.calls.some((c) => c.method === 'stopRecording')).toBe(true);
  });
});
