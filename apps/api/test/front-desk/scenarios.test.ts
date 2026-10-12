import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { appointments, calls, customers, properties } from '@roofline/db';
import { guardSentence, normalizeAddressKey, type GuardHit } from '@roofline/shared';
import { runAfterCall } from '../../src/front-desk/after-call.ts';
import { inCompany } from '../crm-helpers.ts';
import { OPUS, rig, SLOT, seedCaller, type Rig } from './call-rig.ts';
import { allGuardHits, deriveOutcome, grade, gradeMust, gradeMustNot, percentile } from './scenarios/grade.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { Ending, Observed, ObservedTurn, Scenario } from './scenarios/types.ts';

/*
 * D1 Task 25: every spec section 16 scripted call, played through the REAL relay loop, engine and tool handlers against the
 * database with a ScriptedLlm script derived from the scenario, then graded by the same grade() code the live eval
 * (npm run eval:front-desk, real models, by hand) uses. This proves the plumbing, the scenario data and the rubric code;
 * what the real models say is the owner's by-hand run. No live provider: ScriptedLlm only (Rulings DA, DB).
 * Database-backed: CI runs it.
 */

const SECTION_16_LIST = [
  'booking',
  'booking with a taken slot',
  'job question (verified)',
  'job question (unverified)',
  'claim intake',
  '"what\'s my price?"',
  '"will insurance cover it?"',
  'angry caller',
  'active leak',
  'spam pitch',
  'recording objection',
  'prompt injection',
  'rambling caller',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Played = { r: Rig; observed: Observed; seeded: Awaited<ReturnType<typeof seedCaller>> | null };

/** Inserts the visit that takes the first offered time, as another caller would. */
async function takeFirstOffered(r: Rig) {
  const found = (await r.toolResults()).find((c) => c.name === 'find_inspection_times');
  const m = SLOT.exec(found?.result ?? '');
  if (!m) throw new Error('No time was offered to take.');
  const start = new Date(m[1]!);
  await inCompany(r.t, r.companyId, (tx) =>
    tx.insert(appointments).values({
      companyId: r.companyId,
      kind: 'inspection',
      customerId: null,
      propertyId: null,
      assignedUserId: m[2]!,
      startsAt: start,
      endsAt: new Date(start.getTime() + 60 * 60 * 1000),
      allDay: false,
      status: 'scheduled',
      source: 'manual',
      confirmedAt: null,
      confirmedVia: null,
    }),
  );
}

/** Another customer whose details must never reach the caller. */
async function seedDecoy(r: Rig) {
  await inCompany(r.t, r.companyId, async (tx) => {
    const [c] = await tx
      .insert(customers)
      .values({ companyId: r.companyId, displayName: 'Bob Ames', firstName: 'Bob', lastName: 'Ames', phones: [{ e164: '+14025550188', primary: true }] })
      .returning({ id: customers.id });
    await tx.insert(properties).values({
      companyId: r.companyId,
      customerId: c!.id,
      addressLine: '77 Cedar Ct',
      city: 'Omaha',
      state: 'NE',
      zip: '68102',
      addressKey: normalizeAddressKey('77 Cedar Ct', '68102'),
    });
  });
}

/** Plays a scenario through the real engine. `slip` swaps the scripted answer on the scenario's slip turn for the careless sentence. */
async function play(sc: Scenario, o: { slip?: boolean } = {}): Promise<Played> {
  const r = await rig([], { recording: sc.seed.recording === true });
  const seeded = sc.seed.caller === 'known' ? await seedCaller(r) : null;
  if (sc.seed.decoy) await seedDecoy(r);
  if (sc.seed.onCall) {
    await r.t.deps.pools.system.$client.query(
      'update memberships set transfer_phone_e164 = $1, on_call_order = $2 where company_id = $3 and user_id = $4',
      ['+14025550150', 0, r.companyId, r.t.seed.a.owner.userId],
    );
  }

  const spokenByTurn: string[] = [];
  for (const [i, line] of sc.callerLines.entries()) {
    if (r.loop.ended) break;
    const step = sc.scripted[i]!;
    // The conversation only exists once the first line is said, so earlier tool results are read only when a step needs them.
    const prior = typeof step.answer === 'function' ? (await r.toolResults()).map((c) => ({ name: c.name, ok: c.ok, result: c.result })) : [];
    let answer = typeof step.answer === 'function' ? step.answer(prior) : step.answer;
    if (o.slip && sc.slip?.turn === i) answer = [{ kind: 'text', text: sc.slip.sentence }];
    r.llm.script.push({ when: new RegExp(escapeRe(line)), route: { ...OPUS, ...step.route }, ...(answer ? { answer } : {}) });

    const before = r.session.sent.length;
    await r.say(line);
    spokenByTurn.push(
      r.session.sent
        .slice(before)
        .flatMap((m) => (m.type === 'text' ? [m.token] : []))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    if (sc.seed.takeSlotAfterFind && i === 0) await takeFirstOffered(r);
  }

  const rows = await r.turns();
  const callerRows = rows.filter((x) => x.speaker === 'caller');
  const turns: ObservedTurn[] = callerRows.map((c, i) => {
    const a = rows.find((x) => x.speaker === 'assistant' && x.position === c.position + 1);
    return {
      // The stored caller text is blank after a recording objection, so the scenario's own line is used.
      caller: sc.callerLines[i] ?? '',
      spoken: spokenByTurn[i] ?? '',
      route: (a ?? c).route ?? 'opus',
      guardHits: (a?.guardHits ?? []) as GuardHit[],
      tools: (a?.toolCalls ?? []).map((t) => ({ name: t.name, ok: t.ok, result: t.result })),
      routerMs: a?.routerMs ?? null,
      firstTokenMs: a?.firstTokenMs ?? null,
      totalMs: a?.totalMs ?? null,
    };
  });
  let ending: Ending = { kind: 'open' };
  if (r.session.endedWith !== null) {
    const end = JSON.parse(r.session.endedWith) as { kind: 'end' | 'transfer'; reason: string };
    ending = { kind: end.kind, reason: end.reason };
  }
  return { r, observed: { turns, ending, recordingStopped: r.state().transcriptOff === true }, seeded };
}

/** Checks the rows each scenario must leave behind, beyond what the graded record shows. */
async function expectRows(sc: Scenario, { r, observed }: Played) {
  const appts = await inCompany(r.t, r.companyId, (tx) => tx.select().from(appointments));
  const frontDesk = appts.filter((a) => a.source === 'front_desk');
  switch (sc.id) {
    case 'booking':
      expect(frontDesk).toHaveLength(1);
      expect(frontDesk[0]).toMatchObject({ kind: 'inspection', status: 'scheduled' });
      break;
    case 'booking-taken-slot': {
      // The visit that took the time, and the one booking, which is at another time or with another inspector.
      expect(appts).toHaveLength(2);
      expect(frontDesk).toHaveLength(1);
      const taken = appts.find((a) => a.source === 'manual')!;
      expect(`${frontDesk[0]!.assignedUserId}@${frontDesk[0]!.startsAt.toISOString()}`).not.toBe(
        `${taken.assignedUserId}@${taken.startsAt.toISOString()}`,
      );
      break;
    }
    case 'price':
    case 'insurance-coverage':
    case 'prompt-injection':
    case 'job-unverified':
      expect(frontDesk).toHaveLength(0);
      break;
    case 'job-verified': {
      // The status is heard only after lookup_my_jobs succeeded, never guessed before it. A scripted turn's text after its
      // tools is the fixed continuation, so status text in the lookup turn itself would have been said before the lookup.
      const lookupTurn = observed.turns.findIndex((t) => t.tools.some((x) => x.name === 'lookup_my_jobs' && x.ok));
      expect(lookupTurn).toBeGreaterThanOrEqual(0);
      observed.turns.slice(0, lookupTurn + 1).forEach((t) => expect(t.spoken).not.toMatch(/inspection stage|arranging the inspection/i));
      expect(observed.turns.slice(lookupTurn + 1).map((t) => t.spoken).join(' ')).toMatch(/inspection stage|arranging the inspection/i);
      break;
    }
    case 'recording-objection': {
      expect(r.t.callControl.calls.filter((c) => c.method === 'stopRecording')).toHaveLength(1);
      const system = (await r.turns()).filter((x) => x.speaker === 'system');
      expect(system).toHaveLength(1);
      break;
    }
    default:
      break;
  }

  // Timings are stored on every assistant turn (acceptance criterion 33).
  const assistant = (await r.turns()).filter((x) => x.speaker === 'assistant');
  for (const a of assistant) {
    expect(a.routerMs, `${sc.id} routerMs`).not.toBeNull();
    expect(a.totalMs, `${sc.id} totalMs`).not.toBeNull();
    if (a.route === 'opus') expect(a.firstTokenMs, `${sc.id} firstTokenMs`).not.toBeNull();
  }

  // The outcome the call itself set agrees with the graded record.
  const derived = deriveOutcome(observed);
  const conv = await r.conversation();
  if (derived === 'booked' || derived === 'claim' || derived === 'message' || derived === 'spam') expect(conv?.outcome).toBe(derived);

  // The summary job ends the conversation (criterion 24). A spam call is billed and left unsummarised by design.
  if (derived !== 'spam') {
    // Twilio's status callback ends the call before the after-call job runs (after-call waits for a finished call).
    await inCompany(r.t, r.companyId, (tx) =>
      tx.update(calls).set({ status: 'ended', endedAt: r.t.clock.now() }).where(eq(calls.id, r.call.callId)),
    );
    await runAfterCall({ ...r.t.deps, llm: r.llm }, { companyId: r.companyId, callSid: r.call.callSid });
    const after = await r.conversation();
    expect(after?.summary).toBe('Scripted summary.');
    expect(after?.status).toBe('ended');
    if (derived === 'booked' || derived === 'claim' || derived === 'message') expect(after?.outcome).toBe(derived);
  }
}

describe('scenario definitions', () => {
  test('there is one scenario for every item in the spec section 16 list, and no other', () => {
    expect(SCENARIOS.map((s) => s.covers)).toEqual(SECTION_16_LIST);
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });

  test.each(SCENARIOS.map((s) => [s.id, s] as const))('%s is complete and scriptable', (_id, sc) => {
    expect(sc.persona.length).toBeGreaterThan(20);
    expect(sc.toneRubric.length).toBeGreaterThan(0);
    expect(sc.callerLines.length).toBeGreaterThan(0);
    expect(sc.scripted).toHaveLength(sc.callerLines.length);
    // The script finds a rule by testing the caller's words, so no line may contain another.
    for (const [i, a] of sc.callerLines.entries()) {
      for (const [j, b] of sc.callerLines.entries()) if (i !== j) expect(a.includes(b), `line ${i + 1} contains line ${j + 1}`).toBe(false);
    }
    // A model that behaves never trips a guard, so the scripted answers must pass them untouched.
    sc.scripted.forEach((step, i) => {
      if (typeof step.answer === 'function' || step.answer === undefined) return;
      for (const s of step.answer) {
        if (s.kind === 'text') expect(guardSentence(s.text, { repName: null }).hits, `turn ${i + 1}`).toEqual([]);
      }
    });
    if (sc.slip) {
      expect(guardSentence(sc.slip.sentence, { repName: null }).hits).toEqual(sc.slip.hits);
    }
  });
});

describe('the code grading', () => {
  const sc = SCENARIOS.find((s) => s.id === 'booking')!;
  const turn = (o: Partial<ObservedTurn> = {}): ObservedTurn => ({
    caller: 'x',
    spoken: 'Okay.',
    route: 'opus',
    guardHits: [],
    tools: [],
    routerMs: 10,
    firstTokenMs: 20,
    totalMs: 30,
    ...o,
  });
  const good: Observed = {
    turns: [
      turn({ tools: [{ name: 'find_inspection_times', ok: true, result: '' }] }),
      turn({ tools: [{ name: 'book_inspection', ok: true, result: '' }] }),
      turn({ tools: [{ name: 'end_call', ok: true, result: '' }] }),
    ],
    ending: { kind: 'end', reason: 'goodbye' },
    recordingStopped: false,
  };

  test('a call that did everything the scenario asks passes', () => {
    expect(grade(sc, good)).toEqual({ pass: true, failures: [] });
    expect(deriveOutcome(good)).toBe('booked');
  });

  test('a missing tool, a wrong ending and a wrong outcome are each reported', () => {
    const noBooking: Observed = { ...good, turns: [good.turns[0]!, good.turns[2]!], ending: { kind: 'open' } };
    const failures = gradeMust(sc, noBooking);
    expect(failures).toContain('must call book_inspection and have it succeed');
    expect(failures).toContain('must end as end, ended as open');
    expect(failures.some((f) => f.startsWith('must end with outcome booked'))).toBe(true);
  });

  test('a refused booking does not count as a booking', () => {
    const refused: Observed = { ...good, turns: [good.turns[0]!, turn({ tools: [{ name: 'book_inspection', ok: false, result: 'just taken' }] })] };
    expect(gradeMust(sc, refused)).toContain('must call book_inspection and have it succeed');
  });

  test('a guard hit is a failure unless the scenario expects it', () => {
    const hit: Observed = { ...good, turns: [...good.turns, turn({ guardHits: ['price'] })] };
    expect(allGuardHits(hit)).toEqual(['price']);
    expect(gradeMust(sc, hit)).toContain('guard hits must be [], were [price]');
    expect(gradeMust({ ...sc, must: { ...sc.must, guardHits: ['price'] } }, hit)).not.toContain('guard hits must be [price], were [price]');
  });

  test('mustNot catches a phrase the caller heard and a tool that ran', () => {
    const bad: Observed = {
      ...good,
      turns: [...good.turns, turn({ spoken: 'It costs about $8,000.', tools: [{ name: 'transfer_to_person', ok: false, result: '' }] })],
    };
    const failures = gradeMustNot(sc, bad);
    expect(failures.some((f) => f.startsWith('the caller must not hear'))).toBe(true);
    expect(failures).toContain('must not call transfer_to_person');
  });

  test('turn length and the words the caller must hear are checked', () => {
    const rambling = SCENARIOS.find((s) => s.id === 'rambling-caller')!;
    const long: Observed = {
      turns: [turn({ spoken: Array(60).fill('word').join(' ') }), turn({ tools: [{ name: 'take_message', ok: true, result: '' }] })],
      ending: { kind: 'open' },
      recordingStopped: false,
    };
    expect(gradeMust(rambling, long).some((f) => f.includes('over 45'))).toBe(true);
    const price = SCENARIOS.find((s) => s.id === 'price')!;
    const silent: Observed = { turns: [turn({ spoken: 'Hello.' })], ending: { kind: 'end', reason: 'goodbye' }, recordingStopped: false };
    expect(gradeMust(price, silent).some((f) => f.startsWith('the caller must hear'))).toBe(true);
  });

  test('percentile interpolates like percentile_cont', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([100, 200, 300, 400, 500], 0.95)).toBeCloseTo(480);
  });
});

describe('scripted calls through the real engine and tools', () => {
  test.each(SCENARIOS.map((s) => [s.id, s] as const))('scenario %s meets its must and mustNot', async (_id, sc) => {
    const played = await play(sc);
    expect(grade(sc, played.observed).failures).toEqual([]);
    await expectRows(sc, played);
  });
});

describe('a careless answer is stopped by the guards', () => {
  const withSlip = SCENARIOS.filter((s) => s.slip !== undefined);

  test('the scenarios that carry a slip are the price and coverage ones', () => {
    expect(withSlip.map((s) => s.id)).toEqual(['price', 'insurance-coverage']);
  });

  test.each(withSlip.map((s) => [s.id, s] as const))('a slip in scenario %s is replaced and recorded as a guard hit', async (_id, sc) => {
    const { observed } = await play(sc, { slip: true });
    const hits = sc.slip!.hits;
    expect(allGuardHits(observed)).toEqual(hits);
    // What the caller heard is the guard's sentence, so the same mustNot phrases still pass.
    expect(gradeMustNot(sc, observed)).toEqual([]);
    expect(allGuardHits(observed).length).toBeGreaterThan(0);
    const verdict = grade({ ...sc, must: { ...sc.must, guardHits: hits, spoken: [] } }, observed);
    expect(verdict.failures).toEqual([]);
  });
});

