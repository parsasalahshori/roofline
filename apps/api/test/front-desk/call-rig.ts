import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { expect } from 'vitest';
import {
  calls,
  companyPhoneNumbers,
  companySettings,
  conversationTurns,
  createJob,
  customers,
  encrypt,
  getConversation,
  insertCall,
  properties,
  textingRegistrations,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { DEFAULT_WORK_HOURS, normalizeAddressKey } from '@roofline/shared';
import { createEngine } from '../../src/front-desk/engine.ts';
import type { ConversationState, Engine } from '../../src/front-desk/engine-types.ts';
import { createRecording } from '../../src/front-desk/recording.ts';
import { type RelayCall, runRelayLoop } from '../../src/front-desk/relay-session-loop.ts';
import { FRONT_DESK_HANDLERS } from '../../src/front-desk/tools/index.ts';
import { FakeVoiceSession } from '../../src/providers/fakes/voice-session.ts';
import { type Script, ScriptedLlm } from '../../src/providers/fakes/scripted-llm.ts';
import type { RouteDecision } from '../../src/providers/llm.ts';
import { inCompany } from '../crm-helpers.ts';
import { makeTestApp, TEST_ENCRYPTION_KEY } from '../helpers.ts';
import { DAYTIME } from '../sms-helpers.ts';

/*
 * The shared call rig (D1 Task 19, moved here by Task 25 so the scripted scenarios reuse it): one real relay loop,
 * the real engine and the REAL tool handlers over FakeVoiceSession and ScriptedLlm, against the database. No live provider.
 */

export const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

export const FROM = '+14025550177';
export const TO = '+14025550100';
export const TOKEN = 'test-subaccount-token-a';
export const ADDRESS = '123 Elm St, Omaha, NE 68102';
export const HOME_STREET = '412 Oak St';
export const SLOT = /slotStart (\S+), slotUserId ([0-9a-f-]{36})/;

export type Rig = Awaited<ReturnType<typeof rig>>;

export async function rig(script: Script, o: { recording?: boolean } = {}) {
  const t = await makeTestApp();
  t.clock.set(DAYTIME);
  const companyId = t.seed.a.companyId;
  const ctx: TenantContext = { companyId, userId: null, role: 'system', canApproveSpend: false };

  await t.deps.pools.system
    .insert(companyPhoneNumbers)
    .values({ companyId, e164: TO, capabilities: ['sms', 'voice'], providerSid: 'PN_A' });
  await t.deps.pools.system
    .insert(textingRegistrations)
    .values({ companyId, subaccountSid: 'AC_test_sub', subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) })
    .onConflictDoUpdate({
      target: textingRegistrations.companyId,
      set: { subaccountSid: 'AC_test_sub', subaccountAuthTokenEncrypted: encrypt(TOKEN, TEST_ENCRYPTION_KEY) },
    });
  const settings = {
    frontDeskEnabled: true,
    frontDeskTexts: true,
    frontDeskCanMove: true,
    frontDeskCanCancel: true,
    workHours: DEFAULT_WORK_HOURS,
  };
  await inCompany(t, companyId, (tx) =>
    tx.insert(companySettings).values({ companyId, ...settings }).onConflictDoUpdate({ target: companySettings.companyId, set: settings }),
  );

  const llm = new ScriptedLlm(script);
  const deps = { ...t.deps, llm };
  const inner = createEngine(deps, FRONT_DESK_HANDLERS);
  let state: ConversationState | null = null;
  const engine: Engine = {
    ...inner,
    start: async (i) => {
      state = await inner.start(i);
      return state;
    },
  };

  const callSid = `CA${randomUUID().replace(/-/g, '')}`;
  const row = await withTenant(t.deps.pools, ctx, (tx) =>
    insertCall(tx, ctx, { callSid, fromE164: FROM, toE164: TO, forwardedFrom: null, stirVerstat: null, now: t.clock.now() }),
  );
  const call: RelayCall = { callId: row.id, companyId, callSid, from: FROM, to: TO, messageOnly: false };
  const recording = o.recording ? createRecording(deps, call) : undefined;
  if (recording) await recording.start();

  const session = new FakeVoiceSession();
  const loop = runRelayLoop(session, { deps, engine, call, recording });
  session.caller.setup({ customParameters: { callId: call.callId } });

  const turns = () => inCompany(t, companyId, (tx) =>
    tx.select().from(conversationTurns).where(eq(conversationTurns.conversationId, state!.conversationId)).orderBy(asc(conversationTurns.position)),
  );
  const say = async (text: string) => {
    session.caller.say(text);
    await loop.settled();
  };
  const conversation = () => inCompany(t, companyId, (tx) => getConversation(tx, ctx, state!.conversationId));
  const callRow = () => inCompany(t, companyId, async (tx) => (await tx.select().from(calls).where(eq(calls.id, call.callId)))[0]!);
  const assistantTurns = async () => (await turns()).filter((x) => x.speaker === 'assistant');
  const toolResults = async () => (await assistantTurns()).flatMap((x) => x.toolCalls ?? []);

  return { t, llm, ctx, companyId, session, loop, call, say, turns, assistantTurns, toolResults, conversation, callRow, state: () => state! };
}

/** An Opus turn: the router and the first token were timed, and the whole turn was timed. */
export function expectOpusTiming(rows: Awaited<ReturnType<Rig['assistantTurns']>>) {
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(r.route).toBe('opus');
    expect(r.model).toBe('scripted');
    expect(r.routerMs).not.toBeNull();
    expect(r.firstTokenMs).not.toBeNull();
    expect(r.totalMs).not.toBeNull();
    expect(r.inputTokens).not.toBeNull();
    expect(r.outputTokens).not.toBeNull();
  }
}

/** A customer with the caller's phone, a home and an open job (stage inspection). */
export async function seedCaller(r: Rig) {
  const now = r.t.clock.now();
  return inCompany(r.t, r.companyId, async (tx) => {
    const [c] = await tx
      .insert(customers)
      .values({ companyId: r.companyId, displayName: 'Nina Park', firstName: 'Nina', lastName: 'Park', phones: [{ e164: FROM, primary: true }] })
      .returning({ id: customers.id });
    const [p] = await tx
      .insert(properties)
      .values({
        companyId: r.companyId,
        customerId: c!.id,
        addressLine: HOME_STREET,
        city: 'Omaha',
        state: 'NE',
        zip: '68102',
        addressKey: normalizeAddressKey(HOME_STREET, '68102'),
      })
      .returning({ id: properties.id });
    const job = await createJob(tx, r.ctx, { customerId: c!.id, propertyId: p!.id, stage: 'inspection' }, { now });
    return { customerId: c!.id, propertyId: p!.id, jobId: job.id };
  });
}

export const VERIFY = { kind: 'tool' as const, name: 'verify_caller' as const, input: { name: 'Nina Park', street: HOME_STREET } };
