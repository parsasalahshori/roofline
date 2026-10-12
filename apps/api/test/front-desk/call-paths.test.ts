import { and, eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { activities, appointments, calls, claimIntakes, customers, jobs } from '@roofline/db';
import { runAfterCall } from '../../src/front-desk/after-call.ts';
import { SAY_SPAM_ENDING } from '../../src/front-desk/engine.ts';
import { createEngine } from '../../src/front-desk/engine.ts';
import { createRecording } from '../../src/front-desk/recording.ts';
import { runRelayLoop } from '../../src/front-desk/relay-session-loop.ts';
import { identifyCaller } from '../../src/front-desk/tools/caller.ts';
import { FRONT_DESK_HANDLERS } from '../../src/front-desk/tools/index.ts';
import { FakeVoiceSession } from '../../src/providers/fakes/voice-session.ts';
import { ONLY_INSPECTIONS } from '../../src/front-desk/tools/move.ts';
import { inCompany } from '../crm-helpers.ts';
import { ADDRESS, expectOpusTiming, OPUS, rig, seedCaller, SLOT, VERIFY, type Rig } from './call-rig.ts';

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



/** An upcoming inspection on Thursday (DAYTIME is Tuesday) for the seeded caller's job and home. */
async function seedInspection(r: Rig, seeded: Awaited<ReturnType<typeof seedCaller>>) {
  const [a] = await inCompany(r.t, r.companyId, (tx) =>
    tx
      .insert(appointments)
      .values({
        companyId: r.companyId,
        kind: 'inspection',
        jobId: seeded.jobId,
        customerId: seeded.customerId,
        propertyId: seeded.propertyId,
        assignedUserId: r.t.seed.a.owner.userId,
        startsAt: new Date('2026-10-15T15:00:00.000Z'),
        endsAt: new Date('2026-10-15T16:00:00.000Z'),
        source: 'manual',
      })
      .returning({ id: appointments.id }),
  );
  return a!.id;
}

const APPOINTMENT = /Appointment ([0-9a-f-]{36}): inspection on /;

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

    // (e) the call is linked to the conversation, and after-call finishes it
    await inCompany(r.t, r.companyId, (tx) => tx.update(calls).set({ status: 'ended', endedAt: r.t.clock.now() }).where(eq(calls.id, r.call.callId)));
    await runAfterCall({ ...r.t.deps, llm: r.llm }, { companyId: r.companyId, callSid: r.call.callSid });
    expect((await r.callRow()).conversationId).toBe(r.state().conversationId);
    const conv = await r.conversation();
    expect(conv?.status).toBe('ended');
    expect(conv?.outcome).toBe('booked');
    expect(conv?.summary).not.toBeNull();
    expect(await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments))).toHaveLength(1);
    const callActs = await inCompany(r.t, r.companyId, (tx) =>
      tx.select().from(activities).where(and(eq(activities.subjectId, customer!.id), eq(activities.kind, 'call'))),
    );
    expect(callActs).toHaveLength(1);
    expect(callActs[0]).toMatchObject({ actorAgent: 'front_desk' });
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

  test('existing appointment (verified): lookup_my_jobs shows it, then confirm and move act on it', async () => {
    const r = await rig([
      {
        when: /my Thursday inspection/,
        route: { ...OPUS, intent: 'job_status' },
        answer: [VERIFY, { kind: 'tool', name: 'lookup_my_jobs', input: {} }],
      },
    ]);
    const seeded = await seedCaller(r);
    const appointmentId = await seedInspection(r, seeded);
    await r.say('about my Thursday inspection');

    const lookup = (await r.toolResults()).find((c) => c.name === 'lookup_my_jobs');
    expect(lookup?.ok).toBe(true);
    const m = APPOINTMENT.exec(lookup!.result);
    expect(m?.[1]).toBe(appointmentId);
    expect(lookup!.result).toContain('Thursday, October 15');
    expect(r.state().shownIds.has(appointmentId)).toBe(true);
    // The id is for the model only: nothing spoken carries it.
    expect(r.session.assistantText()).not.toContain(appointmentId);

    r.llm.script.push({ when: /please confirm it/, route: OPUS, answer: [{ kind: 'tool', name: 'confirm_appointment', input: { appointmentId } }] });
    await r.say('please confirm it');
    const confirmed = (await r.toolResults()).find((c) => c.name === 'confirm_appointment');
    expect(confirmed).toMatchObject({ ok: true });
    expect(confirmed!.result).toMatch(/^Confirmed the inspection on /);
    const [afterConfirm] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments).where(eq(appointments.id, appointmentId)));
    expect(afterConfirm!.confirmedAt).not.toBeNull();

    r.llm.script.push({
      when: /move it to another day/,
      route: OPUS,
      answer: [{ kind: 'tool', name: 'find_inspection_times', input: { propertyId: seeded.propertyId, address: null, fromDate: '2026-10-19', partOfDay: 'any' } }],
    });
    await r.say('actually, can you move it to another day');
    const found = (await r.toolResults()).find((c) => c.name === 'find_inspection_times');
    expect(found?.ok).toBe(true);
    const slot = SLOT.exec(found!.result);
    expect(slot).not.toBeNull();
    const [, slotStart, slotUserId] = slot!;

    r.llm.script.push({
      when: /first one works/,
      route: OPUS,
      answer: [{ kind: 'tool', name: 'move_inspection', input: { appointmentId, slotStart: slotStart!, slotUserId: slotUserId! } }],
    });
    await r.say('the first one works');
    const moved = (await r.toolResults()).find((c) => c.name === 'move_inspection');
    expect(moved).toMatchObject({ ok: true });
    expect(moved!.result).toMatch(/^Moved the inspection to /);
    const [afterMove] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments).where(eq(appointments.id, appointmentId)));
    expect(afterMove!.startsAt.toISOString()).toBe(new Date(slotStart!).toISOString());
    expect(afterMove!.assignedUserId).toBe(slotUserId);
    expect((await r.conversation())?.outcome).toBe('moved');
    expect(r.session.assistantText()).not.toContain(appointmentId);
  });

  test('existing appointment (phone-matched, not verified): no id is shown, and confirm and move are refused', async () => {
    const r = await rig([
      {
        when: /my Thursday inspection/,
        route: { ...OPUS, intent: 'job_status' },
        answer: [{ kind: 'tool', name: 'lookup_my_jobs', input: {} }],
      },
    ]);
    const seeded = await seedCaller(r);
    const appointmentId = await seedInspection(r, seeded);
    await r.loop.settled();
    await identifyCaller({ deps: r.t.deps, companyId: r.companyId, conversation: r.state(), now: r.t.clock.now() });
    expect(r.state().identity).toBe('matched');
    await r.say('about my Thursday inspection');

    const lookup = (await r.toolResults()).find((c) => c.name === 'lookup_my_jobs');
    expect(lookup).toMatchObject({ ok: true, result: 'You have an appointment on Thursday.' });
    expect(r.state().shownIds.has(appointmentId)).toBe(false);

    // Even a model that somehow has the id cannot act on it.
    r.llm.script.push({
      when: /please confirm it/,
      route: OPUS,
      answer: [
        { kind: 'tool', name: 'confirm_appointment', input: { appointmentId } },
        { kind: 'tool', name: 'move_inspection', input: { appointmentId, slotStart: '2026-10-19T15:00:00.000Z', slotUserId: r.t.seed.a.owner.userId } },
      ],
    });
    await r.say('please confirm it');
    const results = await r.toolResults();
    expect(results.find((c) => c.name === 'confirm_appointment')).toMatchObject({ ok: false, result: "That isn't one of this caller's records." });
    expect(results.find((c) => c.name === 'move_inspection')).toMatchObject({ ok: false, result: "That isn't one of this caller's records." });
    const [row] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments).where(eq(appointments.id, appointmentId)));
    expect(row).toMatchObject({ confirmedAt: null, startsAt: new Date('2026-10-15T15:00:00.000Z') });
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

  test('install move: a verified caller asking to move an install is refused and offered a message (criterion 8)', async () => {
    const r = await rig([]);
    const seeded = await seedCaller(r);
    const start = new Date(r.t.clock.now().getTime() + 3 * 24 * 60 * 60 * 1000);
    const [install] = await inCompany(r.t, r.companyId, (tx) =>
      tx
        .insert(appointments)
        .values({
          companyId: r.companyId,
          kind: 'install',
          customerId: seeded.customerId,
          propertyId: seeded.propertyId,
          jobId: seeded.jobId,
          assignedUserId: r.t.seed.a.owner.userId,
          startsAt: start,
          endsAt: new Date(start.getTime() + 8 * 60 * 60 * 1000),
          allDay: false,
          status: 'scheduled',
          source: 'manual',
        })
        .returning(),
    );
    const newStart = new Date(start.getTime() + 24 * 60 * 60 * 1000).toISOString();
    r.llm.script.push(
      {
        when: /move my install/,
        route: { ...OPUS, intent: 'reschedule' },
        answer: [
          VERIFY,
          { kind: 'tool', name: 'lookup_my_jobs', input: {} },
          { kind: 'tool', name: 'move_inspection', input: { appointmentId: install!.id, slotStart: newStart, slotUserId: r.t.seed.a.owner.userId } },
          { kind: 'text', text: 'I cannot move an install myself. I will take a message for the office.' },
          { kind: 'tool', name: 'take_message', input: { reason: 'Wants to move the install to another day', urgent: false, callbackWhen: null, name: null } },
        ],
      },
      { when: /bye/, route: OPUS, answer: [{ kind: 'tool', name: 'end_call', input: { reason: 'goodbye' } }] },
    );

    await r.say('I need to move my install');
    await r.say('ok, bye');

    const results = await r.toolResults();
    expect(results.map((c) => c.name)).toEqual(['verify_caller', 'lookup_my_jobs', 'move_inspection', 'take_message', 'end_call']);
    // The verified caller's lookup names the install, so the model may use its id.
    expect(results[1]!.result).toContain(`Appointment ${install!.id}: install`);
    // The move reaches the tool (not the shown-ids guard) and is refused there, pointing at a message.
    expect(results[2]).toMatchObject({ ok: false });
    expect(results[2]!.result).toBe(ONLY_INSPECTIONS);
    expect(results[3]).toMatchObject({ ok: true });
    // The install is untouched.
    const [after] = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments).where(eq(appointments.id, install!.id)));
    expect(after).toMatchObject({ kind: 'install', status: 'scheduled' });
    expect(after!.startsAt.toISOString()).toBe(start.toISOString());
    expect((await r.conversation())?.outcome).toBe('message');
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
      ['+14025550166', 0, r.companyId, r.t.seed.a.owner.userId],
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

  test('two relay segments on one call: turn positions run 0..n in order in the one linked conversation', async () => {
    const r = await rig(
      [
        { when: /leaks/, route: OPUS, answer: [{ kind: 'text', text: 'Sorry to hear that.' }] },
        { when: /garage/, route: OPUS, answer: [{ kind: 'text', text: 'Got it, above the garage.' }] },
        { when: /stop recording/, route: OPUS, answer: [{ kind: 'text', text: 'Of course, I stopped the recording.' }] },
        { when: /Friday/, route: OPUS, answer: [{ kind: 'text', text: 'Friday works.' }] },
      ],
      { recording: true },
    );
    // Segment 1: two exchanges, then the socket drops (a transfer that came back, or a reconnect).
    await r.say('my roof leaks');
    await r.say('it is above the garage');
    const conversationId = r.state().conversationId;
    r.session.caller.hangUp();
    await r.loop.settled();

    // Segment 2: a new relay session for the same callId through the real loop and engine. A reused conversation's
    // call time counts from its createdAt (the database clock), so the test clock moves next to it.
    r.t.clock.set(new Date((await r.conversation())!.createdAt.getTime() + 2 * 60_000));
    const deps = { ...r.t.deps, llm: r.llm };
    const engine = createEngine(deps, FRONT_DESK_HANDLERS);
    const recording = createRecording(deps, { ...r.call, alreadyRecording: true });
    await recording.start();
    const session = new FakeVoiceSession();
    const loop = runRelayLoop(session, { deps, engine, call: r.call, recording });
    session.caller.setup({ customParameters: { callId: r.call.callId } });
    for (const line of ['please stop recording', 'can you come Friday']) {
      session.caller.say(line);
      await loop.settled();
    }

    const rows = await r.turns();
    expect(rows.every((x) => x.conversationId === conversationId)).toBe(true);
    expect(rows.map((x) => x.position)).toEqual(rows.map((_, i) => i));
    expect(rows.map((x) => x.speaker)).toEqual(['caller', 'assistant', 'caller', 'assistant', 'system', 'caller', 'assistant', 'caller', 'assistant']);
    expect(rows.filter((x) => x.speaker === 'system')).toHaveLength(1);
    expect((await r.callRow()).conversationId).toBe(conversationId);
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
