import { describe, expect, test } from 'vitest';
import { stepTypes } from '../src/steps.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const ID4 = '44444444-4444-4444-8444-444444444444';
const FACTS = { companyName: 'Acme Roofing' };

/** A distinct, valid v4-shaped uuid for index `i` (1-based), so a list can be made as long as a test needs. */
const uuidFor = (i: number): string => {
  const hex = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};
const uuidList = (n: number): string[] => Array.from({ length: n }, (_, i) => uuidFor(i + 1));

const sms = stepTypes.send_sms_batch;
const email = stepTypes.send_email_batch;
const routes = stepTypes.build_routes;
const ads = stepTypes.create_ad_campaign;

describe('send_sms_batch fields', () => {
  const smsPayload = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'marketing',
    body: "Hi {first_name}, it's {company}. Storm check this week? Reply STOP to opt out.",
    customerIds: [ID],
    ...overrides,
  });

  test('a payload without fields still parses, with no fields key', () => {
    const parsed = sms.payload.parse(smsPayload());
    expect(parsed).not.toHaveProperty('fields');
  });

  test('a payload with fields parses and round-trips', () => {
    const fields = { [ID]: { street: '12 Oak St' } };
    const parsed = sms.payload.parse(smsPayload({ fields }));
    expect(parsed.fields).toEqual(fields);
  });

  test('a field value longer than 60 characters fails', () => {
    const result = sms.payload.safeParse(smsPayload({ fields: { [ID]: { street: 'x'.repeat(61) } } }));
    expect(result.success).toBe(false);
  });

  test('more than 5000 field entries fails', () => {
    const fields = Object.fromEntries(uuidList(5001).map((id) => [id, { street: '1 Main St' }]));
    const result = sms.payload.safeParse(smsPayload({ fields }));
    expect(result.success).toBe(false);
  });

  test('a field value that is not a string fails', () => {
    const result = sms.payload.safeParse(smsPayload({ fields: { [ID]: { street: 12 } } }));
    expect(result.success).toBe(false);
  });
});

describe('send_email_batch', () => {
  const emailPayload = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'marketing',
    subject: 'Hail near your home on {street}',
    body: 'Hello from Acme Roofing {unsubscribe}',
    customerIds: [ID],
    ...overrides,
  });

  test('a valid marketing payload parses', () => {
    expect(email.payload.safeParse(emailPayload()).success).toBe(true);
  });

  test('an informational purpose fails', () => {
    expect(email.payload.safeParse(emailPayload({ purpose: 'informational' })).success).toBe(false);
  });

  test('zero customers fails', () => {
    expect(email.payload.safeParse(emailPayload({ customerIds: [] })).success).toBe(false);
  });

  test('5001 customers fails and 5000 passes', () => {
    expect(email.payload.safeParse(emailPayload({ customerIds: uuidList(5001) })).success).toBe(false);
    expect(email.payload.safeParse(emailPayload({ customerIds: uuidList(5000) })).success).toBe(true);
  });

  test('duplicate customer ids fail', () => {
    expect(email.payload.safeParse(emailPayload({ customerIds: [ID, ID2, ID] })).success).toBe(false);
  });

  test('a blank subject fails', () => {
    expect(email.payload.safeParse(emailPayload({ subject: '   ' })).success).toBe(false);
  });

  test('an unknown key fails (strict)', () => {
    expect(email.payload.safeParse(emailPayload({ extra: 'nope' })).success).toBe(false);
  });

  test('the optional fields, dedupePrefix and companyStormId are accepted', () => {
    const result = email.payload.safeParse(
      emailPayload({
        fields: { [ID]: { street: '12 Oak St' } },
        dedupePrefix: 'storm:abc',
        companyStormId: ID2,
      }),
    );
    expect(result.success).toBe(true);
  });

  test('the preview names the recipient count and renders the sample with the company name', () => {
    const p = email.payload.parse(emailPayload({ customerIds: [ID, ID2, ID3] }));
    const preview = email.preview(p, FACTS);
    expect(preview.title).toBe('Email 3 customers');
    expect(preview.recipientCount).toBe(3);
    expect(preview.messageSample).toContain('Acme Roofing');
    expect(preview.lines).toHaveLength(2);
  });

  test('facts.recipientCount overrides the count in the preview', () => {
    const p = email.payload.parse(emailPayload({ customerIds: [ID, ID2, ID3] }));
    const preview = email.preview(p, { ...FACTS, recipientCount: 40 });
    expect(preview.title).toBe('Email 40 customers');
  });

  test('minutes saved is half a minute per email, capped at 120', () => {
    const p = email.payload.parse(emailPayload());
    expect(email.minutesSaved(p, { sent: 10 })).toBe(5);
    expect(email.minutesSaved(p, { sent: 1000 })).toBe(120);
    expect(email.minutesSaved(p, { sent: 0 })).toBe(0);
    expect(email.minutesSaved(p, {})).toBe(0);
  });

  test('needs a message approval', () => {
    expect(email.approvalClass).toBe('message');
  });
});

describe('build_routes', () => {
  const routePayload = (overrides: Record<string, unknown> = {}) => ({
    companyStormId: ID,
    repUserIds: [ID2, ID3, ID4, uuidFor(5)],
    maxDoors: 600,
    ...overrides,
  });

  test('needs an internal approval', () => {
    expect(routes.approvalClass).toBe('internal');
  });

  test('a valid payload parses', () => {
    expect(routes.payload.safeParse(routePayload()).success).toBe(true);
  });

  test('an empty rep list fails', () => {
    expect(routes.payload.safeParse(routePayload({ repUserIds: [] })).success).toBe(false);
  });

  test('maxDoors is a whole number from 1 to 1500', () => {
    expect(routes.payload.safeParse(routePayload({ maxDoors: 1500 })).success).toBe(true);
    expect(routes.payload.safeParse(routePayload({ maxDoors: 1501 })).success).toBe(false);
    expect(routes.payload.safeParse(routePayload({ maxDoors: 0 })).success).toBe(false);
    expect(routes.payload.safeParse(routePayload({ maxDoors: 1.5 })).success).toBe(false);
  });

  test('the preview titles the routes and doors, with one line per rep', () => {
    const p = routes.payload.parse(routePayload());
    const preview = routes.preview(p, FACTS);
    expect(preview.title).toBe('4 door-knock routes · 600 doors');
    expect(preview.lines).toHaveLength(4);
  });

  test('minutes saved is 120 per route', () => {
    const p = routes.payload.parse(routePayload());
    expect(routes.minutesSaved(p, {})).toBe(480);
  });
});

describe('create_ad_campaign', () => {
  const googlePayload = (overrides: Record<string, unknown> = {}) => ({
    companyStormId: ID,
    platform: 'google',
    maxSpendCents: 15000,
    days: 7,
    headline: 'Hail damage roof repair',
    description: 'Free roof inspection',
    keywords: ['roof repair'],
    ...overrides,
  });
  const metaPayload = (overrides: Record<string, unknown> = {}) => ({
    companyStormId: ID,
    platform: 'meta',
    maxSpendCents: 15000,
    days: 7,
    headline: 'Hail damage roof repair',
    description: 'Free roof inspection',
    primaryText: 'Hail went through your area. Get a free look.',
    ...overrides,
  });

  const firstMessage = (value: unknown): string | undefined => {
    const result = ads.payload.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };

  test('needs a spend approval', () => {
    expect(ads.approvalClass).toBe('spend');
  });

  test('a valid google payload parses', () => {
    expect(ads.payload.safeParse(googlePayload()).success).toBe(true);
  });

  test('a google payload without keywords fails with the plain message', () => {
    expect(firstMessage(googlePayload({ keywords: undefined }))).toBe('Google ads need at least one keyword.');
  });

  test('a meta payload without primaryText fails with the plain message', () => {
    expect(firstMessage(metaPayload({ primaryText: undefined }))).toBe(
      'Facebook and Instagram ads need the main text.',
    );
  });

  test('a meta payload with primaryText parses, with photoId null or a uuid', () => {
    expect(ads.payload.safeParse(metaPayload()).success).toBe(true);
    expect(ads.payload.safeParse(metaPayload({ photoId: null })).success).toBe(true);
    expect(ads.payload.safeParse(metaPayload({ photoId: ID2 })).success).toBe(true);
  });

  test('maxSpendCents runs from 500 to 1,000,000 inclusive', () => {
    expect(ads.payload.safeParse(googlePayload({ maxSpendCents: 499 })).success).toBe(false);
    expect(ads.payload.safeParse(googlePayload({ maxSpendCents: 500 })).success).toBe(true);
    expect(ads.payload.safeParse(googlePayload({ maxSpendCents: 1_000_000 })).success).toBe(true);
    expect(ads.payload.safeParse(googlePayload({ maxSpendCents: 1_000_001 })).success).toBe(false);
  });

  test('days runs from 1 to 30 inclusive', () => {
    expect(ads.payload.safeParse(googlePayload({ days: 0 })).success).toBe(false);
    expect(ads.payload.safeParse(googlePayload({ days: 31 })).success).toBe(false);
    expect(ads.payload.safeParse(googlePayload({ days: 1 })).success).toBe(true);
    expect(ads.payload.safeParse(googlePayload({ days: 30 })).success).toBe(true);
  });

  test('an unknown platform fails', () => {
    expect(ads.payload.safeParse(googlePayload({ platform: 'tiktok' })).success).toBe(false);
  });

  test('the google preview has its title, two lines, the daily rate, and the max spend', () => {
    const p = ads.payload.parse(googlePayload());
    const preview = ads.preview(p, FACTS);
    expect(preview.title).toBe('Google ads on the hail area');
    expect(preview.maxSpendCents).toBe(15000);
    expect(preview.lines).toHaveLength(2);
    expect(preview.lines[1]).toBe('$21.43 a day for 7 days');
  });

  test('the meta preview has its title', () => {
    const p = ads.payload.parse(metaPayload());
    expect(ads.preview(p, FACTS).title).toBe('Facebook and Instagram ads on the hail area');
  });

  test('minutes saved is 45 per campaign', () => {
    const p = ads.payload.parse(googlePayload());
    expect(ads.minutesSaved(p, {})).toBe(45);
  });
});
