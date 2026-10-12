import { describe, expect, test } from 'vitest';
import { TIME_BASELINES } from '../src/agents.ts';
import { isUserCreatableStepType, stepMinutes, stepTypes, type StepResult, type StepType } from '../src/steps.ts';

const MARKETING_MESSAGE = 'Marketing texts must include your company name and "Reply STOP to opt out".';
const FACTS = { companyName: 'Acme Roofing' };
const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const sms = stepTypes.send_sms_batch;
const payload = (overrides: Record<string, unknown> = {}) => ({
  purpose: 'marketing',
  body: "Hi {first_name}, it's {company}. Storm check this week? Reply STOP to opt out.",
  customerIds: [ID],
  ...overrides,
});

/** The first message the payload schema gives for `value`, or null when it passes. */
function schemaMessage(type: StepType, value: unknown): string | null {
  const result = stepTypes[type].payload.safeParse(value, { error: () => 'GENERIC' });
  return result.success ? null : (result.error.issues[0]?.message ?? 'no message');
}

describe('the registry', () => {
  test('lists the nine step types with the approval class each one needs', () => {
    expect(Object.keys(stepTypes).sort()).toEqual([
      'build_routes',
      'create_ad_campaign',
      'demo_message',
      'demo_noop',
      'demo_spend',
      'front_desk_call',
      'front_desk_texts',
      'order_exact_report',
      'send_email_batch',
      'send_proposal',
      'send_sms_batch',
    ]);
    expect(Object.fromEntries(Object.entries(stepTypes).map(([k, d]) => [k, [d.type, d.approvalClass]]))).toEqual({
      demo_noop: ['demo_noop', 'internal'],
      demo_message: ['demo_message', 'message'],
      demo_spend: ['demo_spend', 'spend'],
      front_desk_call: ['front_desk_call', 'internal'],
      front_desk_texts: ['front_desk_texts', 'internal'],
      send_sms_batch: ['send_sms_batch', 'message'],
      send_email_batch: ['send_email_batch', 'message'],
      build_routes: ['build_routes', 'internal'],
      create_ad_campaign: ['create_ad_campaign', 'spend'],
      send_proposal: ['send_proposal', 'message'],
      order_exact_report: ['order_exact_report', 'spend'],
    });
  });
});

describe('send_sms_batch.validate', () => {
  const validate = (p: Record<string, unknown>) => sms.validate!(sms.payload.parse(p), FACTS);

  test('rejects a marketing body without the opt-out wording, with the exact message', () => {
    expect(validate(payload({ body: "Hi {first_name}, it's {company}. Roof check this week?" }))).toBe(MARKETING_MESSAGE);
  });

  test('accepts "Hi {first_name}, it\'s {company}. … Reply STOP to opt out."', () => {
    expect(validate(payload({ body: "Hi {first_name}, it's {company}. Free roof check this week. Reply STOP to opt out." }))).toBeNull();
  });

  test('rejects a marketing body that has the opt-out wording but not the company name', () => {
    expect(validate(payload({ body: 'Hi {first_name}, free roof check this week. Reply STOP to opt out.' }))).toBe(MARKETING_MESSAGE);
  });

  test('accepts the real company name, in any case, instead of {company}', () => {
    expect(validate(payload({ body: 'This is ACME roofing with a free roof check. Reply STOP to opt out.' }))).toBeNull();
  });

  test('the opt-out wording is matched in any case', () => {
    expect(validate(payload({ body: '{company}: free roof check. reply stop TO OPT OUT' }))).toBeNull();
  });

  test('the {company} token is exactly that: {Company} is not rendered, so it does not count', () => {
    expect(validate(payload({ body: '{Company}: free roof check. Reply STOP to opt out.' }))).toBe(MARKETING_MESSAGE);
  });

  test('an informational body needs neither', () => {
    expect(validate(payload({ purpose: 'informational', body: 'Your crew arrives at 8am Tuesday.' }))).toBeNull();
  });

  test('a blank company name cannot satisfy the name rule by itself', () => {
    const p = sms.payload.parse(payload({ body: 'Free roof check. Reply STOP to opt out.' }));
    expect(sms.validate!(p, { companyName: '' })).toBe(MARKETING_MESSAGE);
    expect(sms.validate!(p, { companyName: '   ' })).toBe(MARKETING_MESSAGE);
  });
});

describe('send_sms_batch payload', () => {
  test('a good payload parses; dedupePrefix is optional', () => {
    expect(sms.payload.parse(payload())).toMatchObject({ purpose: 'marketing', customerIds: [ID] });
    expect(sms.payload.parse(payload({ dedupePrefix: 'storm:abc' }))).toMatchObject({ dedupePrefix: 'storm:abc' });
  });

  test('customer ids must be unique, whatever their case', () => {
    expect(schemaMessage('send_sms_batch', payload({ customerIds: [ID, ID2, ID] }))).toBe('Each customer can only be listed once.');
    expect(schemaMessage('send_sms_batch', payload({ customerIds: [ID, ID.toUpperCase()] }))).toBe(
      'Each customer can only be listed once.',
    );
  });

  test('customer ids are stored in lowercase', () => {
    expect(sms.payload.parse(payload({ customerIds: [ID.toUpperCase()] })).customerIds).toEqual([ID]);
  });

  test('1 to 5000 customers', () => {
    expect(schemaMessage('send_sms_batch', payload({ customerIds: [] }))).toBe('Please pick at least one customer.');
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(schemaMessage('send_sms_batch', payload({ customerIds: many(5000) }))).toBeNull();
    expect(schemaMessage('send_sms_batch', payload({ customerIds: many(5001) }))).toBe(
      'You can text at most 5,000 customers in one go.',
    );
  });

  test('a customer id must be a uuid', () => {
    expect(schemaMessage('send_sms_batch', payload({ customerIds: ['nope'] }))).toBe('Please pick customers from your list.');
  });

  test('the body is 1 to 1000 characters', () => {
    expect(schemaMessage('send_sms_batch', payload({ body: '' }))).toBe('Please write the message.');
    expect(schemaMessage('send_sms_batch', payload({ body: '   ' }))).toBe('Please write the message.');
    expect(schemaMessage('send_sms_batch', payload({ body: 'x'.repeat(1000) }))).toBeNull();
    expect(schemaMessage('send_sms_batch', payload({ body: 'x'.repeat(1001) }))).toBe(
      'Please keep the message to 1,000 characters or fewer.',
    );
  });

  test('the purpose is marketing or informational', () => {
    expect(schemaMessage('send_sms_batch', payload({ purpose: 'promo' }))).toBe('Please pick marketing or informational.');
    expect(schemaMessage('send_sms_batch', { body: 'x', customerIds: [ID] })).toBe('Please pick marketing or informational.');
  });

  test('a field nobody asked for is refused, and a NUL character cannot get into the database', () => {
    expect(schemaMessage('send_sms_batch', payload({ extra: 1 }))).toBe('GENERIC');
    expect(schemaMessage('send_sms_batch', payload({ body: 'hi\0 there' }))).toBe('Please check this text.');
  });

  test('nothing in the schema ever shows zod\'s own wording', () => {
    for (const bad of [null, 'text', 7, [], {}, payload({ customerIds: 'x' }), payload({ dedupePrefix: 4 })]) {
      expect(schemaMessage('send_sms_batch', bad)).not.toMatch(/expected|invalid input|too (small|big)/i);
    }
  });
});

describe('demo steps', () => {
  test('demo_noop and demo_message take a label', () => {
    for (const type of ['demo_noop', 'demo_message'] as const) {
      expect(stepTypes[type].payload.parse({ label: '  Knock doors  ' })).toEqual({ label: 'Knock doors' });
      expect(schemaMessage(type, {})).toBe('Please enter a label.');
      expect(schemaMessage(type, { label: '' })).toBe('Please enter a label.');
      expect(schemaMessage(type, { label: 'x'.repeat(201) })).toBe('Please keep the label to 200 characters or fewer.');
    }
  });

  test('demo_spend takes a label and a whole-cents maximum of 0 or more', () => {
    expect(stepTypes.demo_spend.payload.parse({ label: 'Ads', maxSpendCents: 27000 })).toEqual({ label: 'Ads', maxSpendCents: 27000 });
    expect(stepTypes.demo_spend.payload.parse({ label: 'Ads', maxSpendCents: 0 })).toEqual({ label: 'Ads', maxSpendCents: 0 });
    for (const bad of [-1, 1.5, '100', null, undefined]) {
      expect(schemaMessage('demo_spend', { label: 'Ads', maxSpendCents: bad })).toBe(
        'Please enter the most to spend, in cents, as a whole number.',
      );
    }
  });
});

describe('previews', () => {
  test('demo steps show their label; the spend step shows its ceiling', () => {
    expect(stepTypes.demo_noop.preview({ label: 'Door-knock routes for 4 reps' }, FACTS)).toEqual({
      title: 'Door-knock routes for 4 reps',
      lines: [],
    });
    expect(stepTypes.demo_message.preview({ label: 'Text 31 customers' }, FACTS).title).toBe('Text 31 customers');
    expect(stepTypes.demo_spend.preview({ label: 'Ads on the swath', maxSpendCents: 27000 }, FACTS)).toEqual({
      title: 'Ads on the swath',
      lines: ['Spends up to $270.00'],
      maxSpendCents: 27000,
    });
  });

  test('send_sms_batch shows the rendered message for the first customer and the recipient count', () => {
    const p = sms.payload.parse(payload({ customerIds: [ID, ID2] }));
    const preview = sms.preview(p, { companyName: 'Acme Roofing', recipientCount: 2, sampleFirstName: 'Molly' });
    expect(preview).toMatchObject({
      title: 'Text 2 customers',
      messageSample: "Hi Molly, it's Acme Roofing. Storm check this week? Reply STOP to opt out.",
      recipientCount: 2,
    });
    expect(preview.lines.join(' ')).toMatch(/marketing/i);
  });

  test('send_sms_batch falls back to "there" with no sample name and to the id count with no recipient count', () => {
    const p = sms.payload.parse(payload());
    const preview = sms.preview(p, FACTS);
    expect(preview.title).toBe('Text 1 customer');
    expect(preview.recipientCount).toBe(1);
    expect(preview.messageSample).toBe("Hi there, it's Acme Roofing. Storm check this week? Reply STOP to opt out.");
  });
});

describe('demo message and spend details', () => {
  const SAMPLE = "Hi Maria, it's Acme Roofing. Reply STOP to opt out.";

  test('demo_message takes an optional sample, recipient count and send time, and previews them', () => {
    const value = { label: 'Text 31 customers', sample: SAMPLE, recipientCount: 31, sendTime: 'Today 10:00 AM' };
    expect(stepTypes.demo_message.payload.parse(value)).toEqual(value);
    expect(stepTypes.demo_message.preview(value, FACTS)).toEqual({
      title: 'Text 31 customers',
      lines: [],
      messageSample: SAMPLE,
      recipientCount: 31,
      sendTime: 'Today 10:00 AM',
    });
  });

  test('a bare demo_message still parses, and its preview has no extra keys', () => {
    expect(stepTypes.demo_message.payload.parse({ label: 'Text 31 customers' })).toEqual({ label: 'Text 31 customers' });
    expect(stepTypes.demo_message.preview({ label: 'Text 31 customers' }, FACTS)).toEqual({ title: 'Text 31 customers', lines: [] });
  });

  test('the sample is at most 640 characters', () => {
    expect(schemaMessage('demo_message', { label: 'Text', sample: 'x'.repeat(640) })).toBeNull();
    expect(schemaMessage('demo_message', { label: 'Text', sample: 'x'.repeat(641) })).toBe(
      'Please keep the sample to 640 characters or fewer.',
    );
  });

  test('recipientCount is a whole number of 0 or more', () => {
    expect(schemaMessage('demo_message', { label: 'Text', recipientCount: 0 })).toBeNull();
    for (const bad of [-1, 1.5, '31']) {
      expect(schemaMessage('demo_message', { label: 'Text', recipientCount: bad }), String(bad)).toBe(
        'Please enter the number of customers as a whole number.',
      );
    }
  });

  test('the send time is at most 60 characters', () => {
    expect(schemaMessage('demo_message', { label: 'Text', sendTime: 'x'.repeat(60) })).toBeNull();
    expect(schemaMessage('demo_message', { label: 'Text', sendTime: 'x'.repeat(61) })).toBe(
      'Please keep the send time to 60 characters or fewer.',
    );
  });

  test('an unknown key on demo_message is still refused', () => {
    expect(stepTypes.demo_message.payload.safeParse({ label: 'Text 31 customers', extra: 1 }).success).toBe(false);
  });

  test('demo_spend takes an optional area, which previews after the spend line', () => {
    const value = { label: 'Google + Facebook ads on the swath', maxSpendCents: 27000, area: 'North side swath · 4.2 sq mi' };
    expect(stepTypes.demo_spend.payload.parse(value)).toEqual(value);
    expect(stepTypes.demo_spend.preview(value, FACTS)).toEqual({
      title: 'Google + Facebook ads on the swath',
      lines: ['Spends up to $270.00', 'North side swath · 4.2 sq mi'],
      maxSpendCents: 27000,
    });
  });

  test('the area is at most 120 characters', () => {
    expect(schemaMessage('demo_spend', { label: 'Ads', maxSpendCents: 0, area: 'x'.repeat(120) })).toBeNull();
    expect(schemaMessage('demo_spend', { label: 'Ads', maxSpendCents: 0, area: 'x'.repeat(121) })).toBe(
      'Please keep the area to 120 characters or fewer.',
    );
  });
});

describe('minutesSaved', () => {
  test('the demo steps save 5 minutes whatever the result', () => {
    for (const type of ['demo_noop', 'demo_message', 'demo_spend'] as const) {
      expect(stepTypes[type].minutesSaved({}, { ok: 1 })).toBe(5);
    }
  });

  test('send_sms_batch saves 1.5 minutes per text sent, at most 120', () => {
    const p = sms.payload.parse(payload());
    expect(sms.minutesSaved(p, { sent: 10 })).toBe(15);
    expect(sms.minutesSaved(p, { sent: 80 })).toBe(120);
    expect(sms.minutesSaved(p, { sent: 5000 })).toBe(120);
    expect(sms.minutesSaved(p, { sent: 0 })).toBe(0);
  });

  test('send_sms_batch saves nothing when the result has no usable "sent" count', () => {
    const p = sms.payload.parse(payload());
    expect(sms.minutesSaved(p, {})).toBe(0);
    expect(sms.minutesSaved(p, { sent: { a: 1 } })).toBe(0);
    expect(sms.minutesSaved(p, { sent: -4 })).toBe(0);
  });
});

describe('baselines, units and user-creatable step types', () => {
  const FRONT_DESK = ['front_desk_call', 'front_desk_texts'] as const;
  const SAMPLES: [StepType, unknown, StepResult][] = [
    ['demo_noop', { label: 'Knock doors' }, { ok: 1 }],
    ['demo_message', { label: 'Text 31 customers' }, { sent: 3 }],
    ['demo_spend', { label: 'Ads', maxSpendCents: 0 }, {}],
    ['send_sms_batch', payload(), { sent: 31, blocked: 2 }],
    ['front_desk_call', { label: 'Front desk call' }, { seconds: 240, bookings: 1, replies: 0, spam: 0 }],
    ['front_desk_call', { label: 'Front desk call' }, { seconds: 30, spam: 1 }],
    ['front_desk_texts', { label: 'Front desk texts' }, { replies: 3, bookings: 1 }],
  ];

  test('every step type reports a baseline key that exists in TIME_BASELINES', () => {
    for (const [type, p, result] of SAMPLES) {
      const key = stepTypes[type].baseline(stepTypes[type].payload.parse(p), result);
      expect(Object.keys(TIME_BASELINES)).toContain(key);
    }
  });

  test('only the two front desk types are not user-creatable, and the guard agrees', () => {
    for (const type of Object.keys(stepTypes) as StepType[]) {
      const creatable = !(FRONT_DESK as readonly string[]).includes(type);
      expect(stepTypes[type].userCreatable, type).toBe(creatable);
      expect(isUserCreatableStepType(type), type).toBe(creatable);
    }
    expect(isUserCreatableStepType('not_a_step')).toBe(false);
    expect(isUserCreatableStepType(undefined)).toBe(false);
  });

  test('send_sms_batch counts only the "sent" units: {sent: 31, blocked: 2} is 31 units and 46.5 minutes', () => {
    const p = sms.payload.parse(payload());
    expect(stepMinutes(sms, p, { sent: 31, blocked: 2 })).toMatchObject({
      baseline: 'text_sent',
      units: 31,
      minutes: 46.5,
      minutesPerUnit: 1.5,
    });
    expect(stepMinutes(sms, p, { blocked: 5 }).minutes).toBe(0);
    expect(stepMinutes(sms, p, { blocked: 5 }).units).toBe(0);
    expect(stepMinutes(sms, p, { sent: 100 }).minutes).toBe(120);
  });

  test('demo steps are baseline "demo", one unit, five minutes', () => {
    for (const type of ['demo_noop', 'demo_message', 'demo_spend'] as const) {
      const p = stepTypes[type].payload.parse(type === 'demo_spend' ? { label: 'Ads', maxSpendCents: 0 } : { label: 'x' });
      expect(stepMinutes(stepTypes[type], p, {})).toEqual({ baseline: 'demo', units: 1, minutesPerUnit: 5, minutes: 5 });
    }
  });

  test('front_desk_call: an answered call is 2 minutes plus its length', () => {
    const d = stepTypes.front_desk_call;
    const p = d.payload.parse({ label: 'Front desk call' });
    expect(stepMinutes(d, p, { seconds: 240, bookings: 0, replies: 0, spam: 0 })).toMatchObject({
      baseline: 'call_answered',
      units: 1,
      minutes: 6,
    });
    expect(stepMinutes(d, p, { seconds: 240, bookings: 1, replies: 0, spam: 0 }).minutes).toBe(9);
  });

  test('front_desk_call: a spam call is baseline spam_call, counted as the length of the line, with no bookings', () => {
    const d = stepTypes.front_desk_call;
    const p = d.payload.parse({ label: 'Front desk call' });
    expect(stepMinutes(d, p, { seconds: 30, spam: 1 })).toMatchObject({ baseline: 'spam_call', minutes: 0.5 });
    expect(stepMinutes(d, p, { seconds: 30, spam: 1, bookings: 2 }).minutes).toBe(0.5);
  });

  test('front_desk_texts: replies at 2 minutes each, with bookings added at 3 each', () => {
    const d = stepTypes.front_desk_texts;
    const p = d.payload.parse({ label: 'Front desk texts' });
    expect(stepMinutes(d, p, { replies: 3 })).toMatchObject({ baseline: 'text_reply', units: 3, minutes: 6 });
    expect(stepMinutes(d, p, { replies: 2, bookings: 1 }).minutes).toBe(7);
  });

  test('stepMinutes honors owner overrides for visible keys', () => {
    const d = stepTypes.front_desk_texts;
    const p = d.payload.parse({ label: 'Front desk texts' });
    expect(stepMinutes(d, p, { replies: 3 }, { text_reply: 1 }).minutes).toBe(3);
  });

  test('stepMinutes ignores overrides for the hidden demo key', () => {
    const p = stepTypes.demo_noop.payload.parse({ label: 'x' });
    expect(stepMinutes(stepTypes.demo_noop, p, {}, { demo: 1 } as Partial<Record<'demo', number>>).minutes).toBe(5);
  });

  test('the compatibility minutesSaved matches stepMinutes with default minutes', () => {
    for (const [type, p, result] of SAMPLES) {
      const parsed = stepTypes[type].payload.parse(p);
      expect(stepTypes[type].minutesSaved(parsed, result), type).toBe(stepMinutes(stepTypes[type], parsed, result).minutes);
    }
  });
});
