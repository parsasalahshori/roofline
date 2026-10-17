import { describe, expect, test } from 'vitest';
import { type StepResult, stepMinutes, stepTypes } from '../src/steps.ts';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const ID4 = '44444444-4444-4444-8444-444444444444';
const FACTS = { companyName: 'Acme Roofing' };
/** A uuid with letters, so an upper-case form differs from the lower-case one. */
const LOWER_ID = 'abcdef01-1111-4111-8111-111111111111';
const UPPER_ID = LOWER_ID.toUpperCase();

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

  test('the preview fills the storm tokens with sample values, leaving no raw token', () => {
    const body = '{first_name}, hail of {hail_size} hit {street} {day}. {company} {unsubscribe}';
    const p = email.payload.parse(emailPayload({ body }));
    const sample = email.preview(p, FACTS).messageSample ?? '';
    expect(sample).toContain('Sam');
    expect(sample).toContain('1.75"');
    expect(sample).toContain('Maple St');
    expect(sample).toContain('yesterday');
    expect(sample).toContain('Acme Roofing');
    expect(sample).toContain('(unsubscribe link)');
    expect(sample).not.toContain('{street}');
  });

  test('the preview fills the company address when facts give one', () => {
    const p = email.payload.parse(emailPayload({ body: '{company_address} {unsubscribe}' }));
    const sample = email.preview(p, { ...FACTS, companyAddress: '100 Main St' }).messageSample ?? '';
    expect(sample).toContain('100 Main St');
    expect(sample).toContain('(unsubscribe link)');
    expect(sample).not.toContain('{company_address}');
  });

  test('a missing company address is left as a token in the preview', () => {
    const p = email.payload.parse(emailPayload({ body: '{company_address} {unsubscribe}' }));
    const sample = email.preview(p, FACTS).messageSample ?? '';
    expect(sample).toContain('{company_address}');
  });

  test('the preview uses facts.sampleFirstName for the first name when given', () => {
    const p = email.payload.parse(emailPayload({ body: 'Hi {first_name}, {company} {unsubscribe}' }));
    const sample = email.preview(p, { ...FACTS, sampleFirstName: 'Jordan' }).messageSample ?? '';
    expect(sample).toContain('Jordan');
    expect(sample).not.toContain('Sam');
  });

  test('an upper-case customer id parses to lower case', () => {
    const parsed = email.payload.parse(emailPayload({ customerIds: [UPPER_ID] }));
    expect(parsed.customerIds).toEqual([LOWER_ID]);
  });

  test('an upper-case uuid key in fields is rejected', () => {
    const result = email.payload.safeParse(emailPayload({ fields: { [UPPER_ID]: { street: '12 Oak St' } } }));
    expect(result.success).toBe(false);
  });

  test('a lower-case uuid key in fields is accepted', () => {
    const result = email.payload.safeParse(emailPayload({ fields: { [ID]: { street: '12 Oak St' } } }));
    expect(result.success).toBe(true);
  });

  test('minutes saved is half a minute per email, capped at 120', () => {
    const p = email.payload.parse(emailPayload());
    expect(stepMinutes(email, p, { sent: 10 }).minutes).toBe(5);
    expect(stepMinutes(email, p, { sent: 1000 }).minutes).toBe(120);
    expect(stepMinutes(email, p, { sent: 0 }).minutes).toBe(0);
    expect(stepMinutes(email, p, {}).minutes).toBe(0);
    expect(email.baseline(p, {})).toBe('email_sent');
    expect(email.units(p, { sent: 10 })).toBe(10);
    expect(email.userCreatable).toBe(true);
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

  test('minutes saved is 45 per route built (A1 route_built), counted from the result', () => {
    const p = routes.payload.parse(routePayload());
    expect(stepMinutes(routes, p, { routes: 4 }).minutes).toBe(180);
    expect(stepMinutes(routes, p, {}).minutes).toBe(0);
    expect(routes.baseline(p, {})).toBe('route_built');
    expect(routes.units(p, { routes: 4 })).toBe(4);
    expect(routes.userCreatable).toBe(true);
  });

  test('1 rep and 400 doors plans 3 routes (150 doors each at most)', () => {
    const p = routes.payload.parse(routePayload({ repUserIds: [ID2], maxDoors: 400 }));
    const preview = routes.preview(p, FACTS);
    expect(preview.title).toBe('3 door-knock routes · 400 doors');
    expect(preview.lines).toEqual(['Rep 1: 3 routes, up to 400 doors']);
  });

  test('2 reps and 100 doors plan 2 routes, one per rep', () => {
    const p = routes.payload.parse(routePayload({ repUserIds: [ID2, ID3], maxDoors: 100 }));
    const preview = routes.preview(p, FACTS);
    expect(preview.title).toBe('2 door-knock routes · 100 doors');
    expect(preview.lines).toEqual(['Rep 1: 1 route, up to 50 doors', 'Rep 2: 1 route, up to 50 doors']);
  });

  test('the per-rep door counts never add up to more than the plan', () => {
    const p = routes.payload.parse(routePayload({ repUserIds: [ID2, ID3, ID4], maxDoors: 1000 }));
    const lines = routes.preview(p, FACTS).lines;
    const doorCounts = lines.map((line) => Number(/up to ([\d,]+) doors?/.exec(line)?.[1]?.replace(',', '')));
    expect(doorCounts.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(1000);
  });

  test('1500 doors is accepted and 1501 is refused with the plain message', () => {
    expect(routes.payload.safeParse(routePayload({ maxDoors: 1500 })).success).toBe(true);
    const result = routes.payload.safeParse(routePayload({ maxDoors: 1501 }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('You can plan at most 1,500 doors.');
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
    expect(preview.lines[1]).toBe('$21.42 a day for 7 days');
  });

  test('the daily amount is the budget floored to a cent over the days, so the total stays within the maximum', () => {
    const p = ads.payload.parse(googlePayload({ maxSpendCents: 2000, days: 3 }));
    const preview = ads.preview(p, FACTS);
    expect(preview.lines).toContain('$6.66 a day for 3 days');
    expect(preview.lines[1]).toBe('$6.66 a day for 3 days');
  });

  test('the meta preview has its title', () => {
    const p = ads.payload.parse(metaPayload());
    expect(ads.preview(p, FACTS).title).toBe('Facebook and Instagram ads on the hail area');
  });

  test('minutes saved is 45 per campaign created (A1 ad_campaign), counted from the result', () => {
    const p = ads.payload.parse(googlePayload());
    expect(stepMinutes(ads, p, { campaigns: 1 }).minutes).toBe(45);
    expect(stepMinutes(ads, p, {}).minutes).toBe(0);
    expect(ads.baseline(p, {})).toBe('ad_campaign');
    expect(ads.units(p, { campaigns: 1 })).toBe(1);
    // A provider result that names the campaign by id is one campaign created.
    expect(ads.units(p, { campaignId: 'c1' } as unknown as StepResult)).toBe(1);
    expect(ads.units(p, { campaigns: 2 })).toBe(2);
    expect(ads.userCreatable).toBe(true);
  });
});

describe('the storm text sample on the review screen', () => {
  const stormText =
    "Hi {first_name}, it's {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Reply STOP to opt out.";
  const smsPayload = (overrides: Record<string, unknown> = {}) => ({
    purpose: 'marketing',
    body: stormText,
    customerIds: [ID, ID2],
    dedupePrefix: `storm:${ID3}`,
    ...overrides,
  });

  test('a storm text with no details for the customer shows the stand-ins, with no raw token left', () => {
    const p = sms.payload.parse(smsPayload());
    const sample = sms.preview(p, { ...FACTS, sampleFirstName: 'Susan' }).messageSample ?? '';
    expect(sample).toBe("Hi Susan, it's Acme Roofing. Radar shows hail up to 1.75\" hit near your home on Maple St yesterday. Reply STOP to opt out.");
    expect(sample).not.toMatch(/\{[a-z_]+\}/);
  });

  test("a storm text shows the first customer's own hail size and street", () => {
    const fields = { [ID]: { hail_size: '1.5"', street: '2406 Harney St' }, [ID2]: { hail_size: '1"', street: '9 Elm St' } };
    const p = sms.payload.parse(smsPayload({ fields }));
    const sample = sms.preview(p, { ...FACTS, sampleFirstName: 'Susan' }).messageSample ?? '';
    expect(sample).toContain('hail up to 1.5" hit near your home on 2406 Harney St yesterday');
    expect(sample).not.toContain('Maple St');
  });

  test('the email sample reads the first customer details too', () => {
    const fields = { [ID]: { hail_size: '1.5"', street: '2406 Harney St' } };
    const p = email.payload.parse({
      purpose: 'marketing',
      subject: 'Hail near {street}',
      body: 'Hail up to {hail_size} hit {street}. {company} {unsubscribe}',
      customerIds: [ID],
      fields,
    });
    const sample = email.preview(p, FACTS).messageSample ?? '';
    expect(sample).toContain('Hail up to 1.5" hit 2406 Harney St.');
  });

  test('a plain text with no storm batch leaves other braces exactly as written', () => {
    const p = sms.payload.parse({
      purpose: 'marketing',
      body: "Hi {first_name}, it's {company}. Our {day} special is here. Reply STOP to opt out.",
      customerIds: [ID],
    });
    const sample = sms.preview(p, FACTS).messageSample ?? '';
    expect(sample).toContain('{day}');
  });
});

describe('the storm email subject sample', () => {
  test('the subject is filled in with the first customer details and has no raw token', () => {
    const fields = { [ID]: { hail_size: '1.5"', street: '2406 Harney St' } };
    const p = email.payload.parse({
      purpose: 'marketing',
      subject: 'Hail near your home on {street}',
      body: '{company} {company_address} {unsubscribe}',
      customerIds: [ID],
      fields,
    });
    expect(email.preview(p, FACTS).subjectSample).toBe('Hail near your home on 2406 Harney St');
  });

  test('without details the subject shows the stand-in street', () => {
    const p = email.payload.parse({
      purpose: 'marketing',
      subject: 'Hail near your home on {street}',
      body: '{company} {company_address} {unsubscribe}',
      customerIds: [ID],
    });
    expect(email.preview(p, FACTS).subjectSample).toBe('Hail near your home on Maple St');
  });
});
