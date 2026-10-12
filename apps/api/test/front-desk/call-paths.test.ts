import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import {
  activities,
  appointments,
  calls,
  claimIntakes,
  companyPhoneNumbers,
  companySettings,
  conversationTurns,
  createJob,
  customers,
  encrypt,
  getConversation,
  insertCall,
  jobs,
  properties,
  textingRegistrations,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { DEFAULT_WORK_HOURS, normalizeAddressKey } from '@roofline/shared';
import { createEngine, SAY_SPAM_ENDING } from '../../src/front-desk/engine.ts';
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
 * NEEDS-FIX (for the lead; none blocks these tests):
 *  - listTurns (packages/db) returns no timing columns, so this file reads conversation_turns directly with
 *    drizzle to assert routerMs / firstTokenMs / totalMs. Nothing to change unless a repo accessor is wanted.
 *  - If the engine ever calls identifyCaller at start (phone match without verify_caller), the claim and
 *    message scenarios could drop their verify_caller step; today nothing calls it, so they verify first.
 *
 * D1 Task 19: one integration test per call path, through FakeVoiceSession + ScriptedLlm + the real relay loop,
 * the real engine and the REAL tool handlers (FRONT_DESK_HANDLERS) against the database. No live provider.
 * Database-backed: CI runs it.
 */

const OPUS: RouteDecision = { intent: 'other', urgent: false, mood: 'calm', route: 'opus', fastReply: null };

const FROM = '+14025550177';
const TO = '+14025550100';
const TOKEN = 'test-subaccount-token-a';
const ADDRESS = '123 Elm St, Omaha, NE 68102';
const HOME_STREET = '412 Oak St';
const SLOT = /slotStart (\S+), slotUserId ([0-9a-f-]{36})/;

type Rig = Awaited<ReturnType<typeof rig>>;

async function rig(script: Script, o: { recording?: boolean } = {}) {
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
function expectOpusTiming(rows: Awaited<ReturnType<Rig['assistantTurns']>>) {
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
async function seedCaller(r: Rig) {
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

const VERIFY = { kind: 'tool' as const, name: 'verify_caller' as const, input: { name: 'Nina Park', street: HOME_STREET } };

describe('front desk call paths (real relay loop, real engine, real tools)', () => {
  test('booking: find times, book the offered slot, then goodbye', async () => {
    const r = await rig([
      {
        when: /need an inspection/,
        route: { ...OPUS, intent: 'schedule_inspection' },
        answer: [
          { kind: 'text', text: 'Let me look at the calendar.' },
          { kind: 'tool', name: 'find_inspection_times', input: { propertyId: null, address: ADDRESS, fromDate: '2026-10-14', partOfDay: 'morning' } },
        ],
      },
      { when: /bye/, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    ]);

    await r.say('I need an inspection at 123 Elm St');
    const found = (await r.toolResults()).find((c) => c.name === 'find_inspection_times');
    expect(found?.ok).toBe(true);
    const m = SLOT.exec(found!.result);
    expect(m).not.toBeNull();
    const [, slotStart, slotUserId] = m!;

    // The model books the slot the tool returned.
    r.llm.script.push({
      when: /Rita Gomez/,
      route: OPUS,
      answer: [
        {
          kind: 'tool',
          name: 'book_inspection',
          input: { slotStart: slotStart!, slotUserId: slotUserId!, propertyId: null, address: ADDRESS, firstName: 'Rita', lastName: 'Gomez', notes: 'Leak over the garage' },
        },
      ],
    });
    await r.say('That one works, my name is Rita Gomez');
    expect(r.loop.ended).toBe(false);
    await r.say('great, bye');

    // (a) outcome
    expect((await r.conversation())?.outcome).toBe('booked');
    expect((await r.toolResults()).find((c) => c.name === 'book_inspection')).toMatchObject({ ok: true });
    // (c) records
    const appts = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments));
    expect(appts).toHaveLength(1);
    expect(appts[0]).toMatchObject({ kind: 'inspection', source: 'front_desk', status: 'scheduled', assignedUserId: slotUserId });
    expect(appts[0]!.startsAt.toISOString()).toBe(new Date(slotStart!).toISOString());
    const [customer] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(customers));
    expect(customer).toMatchObject({ displayName: 'Rita Gomez', source: 'call' });
    const [job] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(jobs));
    expect(job).toMatchObject({ source: 'front_desk', customerId: customer!.id });
    expect(appts[0]).toMatchObject({ jobId: job!.id, customerId: customer!.id });
    // (b) turns with timings
    expectOpusTiming(await r.assistantTurns());
    // (d) the end message
    expect(r.loop.ended).toBe(true);
    expect(JSON.parse(r.session.endedWith!)).toEqual({ kind: 'end', reason: 'goodbye' });
  });

  test('job question (verified): verify_caller then lookup_my_jobs shows the job', async () => {
    const r = await rig([
      {
        when: /where is my job/,
        route: { ...OPUS, intent: 'job_status' },
        answer: [
          { kind: 'text', text: 'Your job is in the inspection stage.' },
          VERIFY,
          { kind: 'tool', name: 'lookup_my_jobs', input: {} },
        ],
      },
    ]);
    const seeded = await seedCaller(r);
    await r.say('where is my job');

    expect(r.state().identity).toBe('verified');
    expect(r.state().customerId).toBe(seeded.customerId);
    const results = await r.toolResults();
    expect(results.map((c) => c.name)).toEqual(['verify_caller', 'lookup_my_jobs']);
    expect(results.every((c) => c.ok)).toBe(true);
    const lookup = results[1]!;
    expect(lookup.result).toContain(seeded.jobId);
    expect(lookup.result).toContain('inspection stage');
    // The jobs and their homes are now ids the model may use.
    expect(r.state().shownIds.has(seeded.jobId)).toBe(true);
    expect(r.state().shownIds.has(seeded.propertyId)).toBe(true);
    expect(r.session.assistantText()).toContain('inspection stage');
    expectOpusTiming(await r.assistantTurns());
    expect(r.loop.ended).toBe(false);
    expect(r.session.endedWith).toBeNull();
  });

  test('claim: take_claim_details links the intake to the verified caller job', async () => {
    const r = await rig([
      {
        when: /hail claim/,
        route: { ...OPUS, intent: 'insurance_claim' },
        answer: [
          VERIFY,
          {
            kind: 'tool',
            name: 'take_claim_details',
            input: { jobId: null, insurer: 'Acme Mutual', claimNumber: 'CL-1', dateOfLoss: '2026-10-01', description: 'Hail damage to the north slope', adjusterVisitAt: null },
          },
        ],
      },
      { when: /bye/, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    ]);
    const seeded = await seedCaller(r);
    await r.say('I have a hail claim');
    await r.say('thanks, bye');

    expect((await r.conversation())?.outcome).toBe('claim');
    const intakes = await inCompany(r.t, r.companyId, (tx) => tx.select().from(claimIntakes));
    expect(intakes).toHaveLength(1);
    expect(intakes[0]).toMatchObject({ jobId: seeded.jobId, conversationId: r.state().conversationId, takenBy: 'front_desk' });
    const acts = await inCompany(r.t, r.companyId, (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, seeded.jobId), eq(activities.kind, 'claim.intake_taken'))),
    );
    expect(acts.map((a) => a.summary)).toEqual(['Claim details taken by Front Desk']);
    expect((await r.toolResults()).find((c) => c.name === 'take_claim_details')).toMatchObject({ ok: true });
    expectOpusTiming(await r.assistantTurns());
    expect(JSON.parse(r.session.endedWith!)).toEqual({ kind: 'end', reason: 'goodbye' });
  });

  test('message: a non-urgent take_message sets the job next step and leaves an activity', async () => {
    const r = await rig([
      {
        when: /leave a message/,
        route: { ...OPUS, intent: 'message' },
        answer: [
          VERIFY,
          { kind: 'tool', name: 'take_message', input: { reason: 'Please call about the gutter quote', urgent: false, callbackWhen: 'tomorrow morning', name: null } },
        ],
      },
      { when: /bye/, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    ]);
    const seeded = await seedCaller(r);
    await r.say('I want to leave a message');
    await r.say('ok, bye');

    const conv = await r.conversation();
    expect(conv?.outcome).toBe('message');
    const [job] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(jobs).where(eq(jobs.id, seeded.jobId)));
    expect(job!.nextStep).toBe('Call back: Please call about the gutter quote');
    const acts = await inCompany(r.t, r.companyId, (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, seeded.jobId), eq(activities.kind, 'front_desk_message'))),
    );
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ summary: 'Message taken by Front Desk', actorAgent: 'front_desk' });
    // Non-urgent: nobody is emailed.
    expect(r.t.mailer.sent).toHaveLength(0);
    expectOpusTiming(await r.assistantTurns());
    expect(JSON.parse(r.session.endedWith!)).toEqual({ kind: 'end', reason: 'goodbye' });
  });

  test('transfer on a leak: transfer_to_person ends the call with a transfer handoff', async () => {
    const r = await rig([
      {
        when: /roof is leaking/,
        route: { ...OPUS, intent: 'other', urgent: true },
        answer: [
          { kind: 'text', text: 'I am sorry, let me get someone right away.' },
          { kind: 'tool', name: 'transfer_to_person', input: { reason: 'leak', summary: 'Water coming through the ceiling' } },
        ],
      },
    ]);
    const q = r.t.deps.pools.system.$client;
    await q.query(
      'update memberships set transfer_phone_e164 = $1, on_call_order = $2 where company_id = $3 and user_id = $4',
      ['+14025550200', 0, r.companyId, r.t.seed.a.owner.userId],
    );
    await r.say('my roof is leaking into the kitchen');

    expect(r.loop.ended).toBe(true);
    expect(JSON.parse(r.session.endedWith!)).toMatchObject({ kind: 'transfer', reason: 'leak', summary: 'Water coming through the ceiling' });
    expect(r.session.sent.at(-1)?.type).toBe('end');
    const tool = (await r.toolResults()).find((c) => c.name === 'transfer_to_person');
    expect(tool).toMatchObject({ ok: true });
    expect(tool!.result).toContain('connecting');
    expect(tool!.result).not.toMatch(/\+?\d{7,}/);
    expectOpusTiming(await r.assistantTurns());
    const spoken = (await r.assistantTurns()).map((x) => x.text).join(' ');
    expect(spoken).toContain('let me get someone');
  });

  test('angry caller: the router sends a transfer and the call ends with reason angry', async () => {
    const r = await rig([
      { when: /ridiculous/, route: { ...OPUS, intent: 'complaint', mood: 'angry', route: 'transfer' } },
    ]);
    await r.say('this is ridiculous, I want answers');

    expect(r.loop.ended).toBe(true);
    expect(JSON.parse(r.session.endedWith!)).toMatchObject({ kind: 'transfer', reason: 'angry' });
    const rows = await r.turns();
    expect(rows.map((x) => x.speaker)).toEqual(['caller']);
    expect(rows[0]).toMatchObject({ route: 'transfer', text: 'this is ridiculous, I want answers' });
    // The speculative Opus call was dropped: nothing was spoken.
    expect(r.session.assistantText()).toBe('');
    expect(r.llm.calls.some((c) => c.kind === 'route')).toBe(true);
  });

  test('recording objection: recording stops, turns are saved with blank text and a system turn', async () => {
    const r = await rig([{ when: /./, route: OPUS, answer: [{ kind: 'text', text: 'Of course, I stopped the recording.' }] }], { recording: true });
    await r.say('please stop recording');

    expect(r.state().transcriptOff).toBe(true);
    expect(r.t.callControl.calls.filter((c) => c.method === 'stopRecording')).toHaveLength(1);
    const rows = await r.turns();
    const system = rows.filter((x) => x.speaker === 'system');
    expect(system).toHaveLength(1);
    expect(system[0]!.text).toBe("Recording and transcript stopped at the caller's request");
    const saved = rows.filter((x) => x.speaker === 'caller' || x.speaker === 'assistant');
    expect(saved.map((x) => x.speaker).sort()).toEqual(['assistant', 'caller']);
    for (const x of saved) expect(x.text).toBe('');
    // The caller still hears the answer; only the stored transcript is blank.
    expect(r.session.assistantText()).toContain('Of course');
    const assistant = rows.find((x) => x.speaker === 'assistant')!;
    expect(assistant.routerMs).not.toBeNull();
    expect(assistant.firstTokenMs).not.toBeNull();
    expect(assistant.totalMs).not.toBeNull();
    expect(r.loop.ended).toBe(false);
  });

  test('spam: a sales pitch is answered with the polite ending and marked spam on the conversation and the call', async () => {
    const r = await rig([
      { when: /extended warranty/, route: { ...OPUS, intent: 'sales_pitch', route: 'opus' }, answer: [{ kind: 'text', text: 'Sure, tell me more.' }] },
    ]);
    await r.say('I am calling about an extended warranty for your roof');

    expect(r.loop.ended).toBe(true);
    expect(JSON.parse(r.session.endedWith!)).toEqual({ kind: 'end', reason: 'spam' });
    expect(r.session.assistantText().replace(/\s+/g, '')).toContain(SAY_SPAM_ENDING.replace(/\s+/g, ''));
    expect(r.session.assistantText()).not.toContain('tell me more');
    expect((await r.conversation())?.outcome).toBe('spam');
    expect((await r.callRow()).spamReason).toBe('assistant_spam');
    const rows = await r.turns();
    const assistant = rows.find((x) => x.speaker === 'assistant')!;
    expect(assistant).toMatchObject({ route: 'end', text: SAY_SPAM_ENDING });
    expect(assistant.routerMs).not.toBeNull();
    expect(assistant.totalMs).not.toBeNull();
  });
});
