import { describe, expect, test } from 'vitest';
import { isUserCreatableStepType, stepMinutes, stepTypes, type StepType } from '../src/steps.ts';

const FACTS = { companyName: 'Acme Roofing' };
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const J1 = '33333333-3333-4333-8333-333333333333';
const U1 = '44444444-4444-4444-8444-444444444444';
const A1 = '55555555-5555-4555-8555-555555555555';

const texts = stepTypes.send_personal_texts;
const packet = stepTypes.build_claim_packet;
const create = stepTypes.create_appointment;
const move = stepTypes.move_appointment;

const ok = (type: StepType, value: unknown) => stepTypes[type].payload.safeParse(value).success;

const message = (i: number, body = 'Hi, checking in about your roof.') => ({
  customerId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  jobId: null,
  body,
});
const textsPayload = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'informational',
  kind: 'reminder',
  messages: [message(1)],
  dedupePrefix: 'reminder:2026-10-13',
  ...overrides,
});
const manyMessages = (n: number) => Array.from({ length: n }, (_, i) => message(i + 1, `Body ${i + 1}`));

describe('send_personal_texts payload', () => {
  test('accepts a good payload', () => {
    expect(ok('send_personal_texts', textsPayload())).toBe(true);
    expect(ok('send_personal_texts', textsPayload({ messages: [{ customerId: C1, jobId: J1, body: 'Hello' }] }))).toBe(true);
  });

  test('message count: 0 and 101 fail, 1 and 100 pass', () => {
    expect(ok('send_personal_texts', textsPayload({ messages: [] }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ messages: manyMessages(1) }))).toBe(true);
    expect(ok('send_personal_texts', textsPayload({ messages: manyMessages(100) }))).toBe(true);
    expect(ok('send_personal_texts', textsPayload({ messages: manyMessages(101) }))).toBe(false);
  });

  test('duplicate customerIds fail', () => {
    const dup = [
      { customerId: C1, jobId: null, body: 'a' },
      { customerId: C1, jobId: null, body: 'b' },
    ];
    expect(ok('send_personal_texts', textsPayload({ messages: dup }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ messages: [dup[0], { ...dup[1], customerId: C2 }] }))).toBe(true);
  });

  test('body length: empty fails, 480 passes, 481 fails; a NUL fails', () => {
    const withBody = (body: string) => textsPayload({ messages: [{ customerId: C1, jobId: null, body }] });
    expect(ok('send_personal_texts', withBody(''))).toBe(false);
    expect(ok('send_personal_texts', withBody('a'.repeat(480)))).toBe(true);
    expect(ok('send_personal_texts', withBody('a'.repeat(481)))).toBe(false);
    expect(ok('send_personal_texts', withBody('hi\u0000there'))).toBe(false);
  });

  test('bad dedupePrefix, purpose, kind and unknown keys fail', () => {
    expect(ok('send_personal_texts', textsPayload({ dedupePrefix: 'Has Space' }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ dedupePrefix: '' }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ dedupePrefix: 'a'.repeat(80) }))).toBe(true);
    expect(ok('send_personal_texts', textsPayload({ dedupePrefix: 'a'.repeat(81) }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ purpose: 'urgent' }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ kind: 'other' }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ extra: 1 }))).toBe(false);
    expect(ok('send_personal_texts', textsPayload({ messages: [{ ...message(1), extra: 1 }] }))).toBe(false);
  });

  test('every follow-up kind is accepted', () => {
    for (const kind of ['proposal', 'lead', 'review', 'claims', 'reminder', 'no_show']) {
      expect(ok('send_personal_texts', textsPayload({ kind })), kind).toBe(true);
    }
  });
});

describe('send_personal_texts.validate', () => {
  const validate = (p: Record<string, unknown>) => texts.validate!(texts.payload.parse(p), FACTS);
  const one = (body: string) => [{ customerId: C1, jobId: null, body }];

  test('a text about prices is refused with the exact message', () => {
    expect(validate(textsPayload({ messages: one('Your roof will cost $9,000.') }))).toBe(
      'This text talks about prices, insurance coverage or deductibles, or offers to deal with the insurer. Please change it.',
    );
  });

  test('one bad message among clean ones is refused', () => {
    const messages = [...one('See you tomorrow.'), { customerId: C2, jobId: null, body: 'Your roof will cost $9,000.' }];
    expect(validate(textsPayload({ messages }))).toBe('This text talks about prices, insurance coverage or deductibles, or offers to deal with the insurer. Please change it.');
  });

  test('a review request must be marketing', () => {
    expect(validate(textsPayload({ kind: 'review', purpose: 'informational' }))).toBe('Review requests go out as marketing texts.');
    expect(validate(textsPayload({ kind: 'review', purpose: 'marketing', messages: one('Thanks for choosing us. Would you leave a review?') }))).toBeNull();
  });

  test('a clean informational reminder passes', () => {
    expect(validate(textsPayload({ messages: one('Reminder: our crew arrives tomorrow at 8am.') }))).toBeNull();
  });
});

describe('G1 previews', () => {
  const preview = (p: Record<string, unknown>) => texts.preview(texts.payload.parse(p), FACTS);

  test('send_personal_texts titles are singular for 1 and plural otherwise', () => {
    expect(preview(textsPayload()).title).toBe('Send 1 personal text');
    expect(preview(textsPayload({ messages: manyMessages(2) })).title).toBe('Send 2 personal texts');
  });

  test('21 messages show 20 bodies and "and 1 more"', () => {
    const result = preview(textsPayload({ messages: manyMessages(21) }));
    expect(result.lines).toHaveLength(21);
    expect(result.lines.slice(0, 20)).toEqual(Array.from({ length: 20 }, (_, i) => `Body ${i + 1}`));
    expect(result.lines[20]).toBe('and 1 more');
    expect(result.recipientCount).toBe(21);
    expect(result.messageSample).toBe('Body 1');
  });

  test('20 messages show exactly 20 lines with no "and … more"', () => {
    const result = preview(textsPayload({ messages: manyMessages(20) }));
    expect(result.lines).toHaveLength(20);
    expect(result.lines.some((l) => /^and \d+ more$/.test(l))).toBe(false);
  });

  test('build_claim_packet', () => {
    expect(packet.preview(packet.payload.parse({ jobId: J1 }), FACTS).title).toBe('Build the claim packet');
  });

  test('create_appointment titles and time range', () => {
    const base = { jobId: J1, start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:00:00Z', userId: U1, note: '' };
    const adjuster = create.preview(create.payload.parse({ ...base, kind: 'adjuster' }), FACTS);
    const inspection = create.preview(create.payload.parse({ ...base, kind: 'inspection' }), FACTS);
    expect(adjuster.title).toBe('Book an adjuster visit');
    expect(inspection.title).toBe('Book an inspection');
    expect(adjuster.lines.some((l) => l.includes('2026-10-14T15:00:00Z') && l.includes('2026-10-14T16:00:00Z'))).toBe(true);
  });

  test('move_appointment title and reason', () => {
    const p = move.payload.parse({
      appointmentId: A1,
      start: '2026-10-15T15:00:00Z',
      end: '2026-10-15T19:00:00Z',
      userId: U1,
      reason: 'Rain likely Thursday (70%)',
    });
    const result = move.preview(p, FACTS);
    expect(result.title).toBe('Move an install');
    expect(result.lines.some((l) => l.includes('Rain likely Thursday (70%)'))).toBe(true);
    // The new time as data, for a list of plans that never sees the payload
    expect(result.moves).toEqual({ start: '2026-10-15T15:00:00Z', end: '2026-10-15T19:00:00Z' });
  });
});

describe('build_claim_packet payload', () => {
  test('needs a uuid jobId and nothing else', () => {
    expect(ok('build_claim_packet', { jobId: J1 })).toBe(true);
    expect(ok('build_claim_packet', { jobId: 'nope' })).toBe(false);
    expect(ok('build_claim_packet', {})).toBe(false);
    expect(ok('build_claim_packet', { jobId: J1, extra: 1 })).toBe(false);
  });
});

describe('appointment payloads', () => {
  const createBase = { jobId: J1, kind: 'adjuster', start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:00:00Z', userId: U1, note: '' };
  const moveBase = { appointmentId: A1, start: '2026-10-15T15:00:00Z', end: '2026-10-15T19:00:00Z', userId: U1, reason: 'Rain' };

  test('create_appointment good and bad cases', () => {
    expect(ok('create_appointment', createBase)).toBe(true);
    expect(ok('create_appointment', { ...createBase, kind: 'inspection', note: 'a'.repeat(500) })).toBe(true);
    expect(ok('create_appointment', { ...createBase, note: 'a'.repeat(501) })).toBe(false);
    expect(ok('create_appointment', { ...createBase, kind: 'install' })).toBe(false);
    expect(ok('create_appointment', { ...createBase, end: createBase.start })).toBe(false);
    expect(ok('create_appointment', { ...createBase, end: '2026-10-14T14:00:00Z' })).toBe(false);
    expect(ok('create_appointment', { ...createBase, start: 'tomorrow' })).toBe(false);
    expect(ok('create_appointment', { ...createBase, extra: 1 })).toBe(false);
  });

  test('move_appointment good and bad cases', () => {
    expect(ok('move_appointment', moveBase)).toBe(true);
    expect(ok('move_appointment', { ...moveBase, reason: 'a'.repeat(200) })).toBe(true);
    expect(ok('move_appointment', { ...moveBase, reason: 'a'.repeat(201) })).toBe(false);
    expect(ok('move_appointment', { ...moveBase, end: moveBase.start })).toBe(false);
    expect(ok('move_appointment', { ...moveBase, end: '2026-10-15T14:00:00Z' })).toBe(false);
    expect(ok('move_appointment', { ...moveBase, extra: 1 })).toBe(false);
  });
});

describe('G1 baselines and units', () => {
  test('reminder texts: 10 sent is 10 units and 10 minutes', () => {
    const p = texts.payload.parse(textsPayload({ kind: 'reminder' }));
    expect(stepMinutes(texts, p, { sent: 10 })).toMatchObject({ baseline: 'reminder_sent', units: 10, minutes: 10 });
  });

  test('follow-up texts: 100 sent is capped at 120 minutes, 0 sent is 0', () => {
    const p = texts.payload.parse(textsPayload({ kind: 'lead' }));
    expect(stepMinutes(texts, p, { sent: 100 })).toMatchObject({ baseline: 'follow_up_sent', minutes: 120 });
    expect(stepMinutes(texts, p, { sent: 0 }).minutes).toBe(0);
  });

  test('build_claim_packet', () => {
    const p = packet.payload.parse({ jobId: J1 });
    expect(stepMinutes(packet, p, { built: 1 })).toMatchObject({ baseline: 'claim_packet', minutes: 30 });
    expect(stepMinutes(packet, p, { built: 0 }).minutes).toBe(0);
  });

  test('create_appointment counts as a booking', () => {
    const p = create.payload.parse({ jobId: J1, kind: 'adjuster', start: '2026-10-14T15:00:00Z', end: '2026-10-14T16:00:00Z', userId: U1, note: '' });
    expect(stepMinutes(create, p, { created: 1 })).toMatchObject({ baseline: 'booking', minutes: 3 });
  });

  test('move_appointment', () => {
    const p = move.payload.parse({ appointmentId: A1, start: '2026-10-15T15:00:00Z', end: '2026-10-15T19:00:00Z', userId: U1, reason: 'Rain' });
    expect(stepMinutes(move, p, { moved: 1 })).toMatchObject({ baseline: 'install_moved', minutes: 10 });
  });
});

describe('G1 registry entries', () => {
  const G1 = ['send_personal_texts', 'build_claim_packet', 'create_appointment', 'move_appointment'] as const;

  test('none is user-creatable', () => {
    for (const t of G1) {
      expect(stepTypes[t].userCreatable, t).toBe(false);
      expect(isUserCreatableStepType(t), t).toBe(false);
    }
  });

  test('approval classes', () => {
    expect(texts.approvalClass).toBe('message');
    expect(packet.approvalClass).toBe('internal');
    expect(create.approvalClass).toBe('internal');
    expect(move.approvalClass).toBe('internal');
  });
});
