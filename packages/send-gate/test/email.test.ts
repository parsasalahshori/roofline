import { DateTime } from 'luxon';
import { describe, expect, test } from 'vitest';
import { GATE_RULES } from '@roofline/shared';
import { decideEmail, type EmailGateRequest } from '../src/index.ts';

const CHICAGO = 'America/Chicago';

/** A wall-clock moment in Chicago, as the Date the gate receives. */
const chi = (iso: string): Date => DateTime.fromISO(iso, { zone: CHICAGO }).toJSDate();

const MARKETING_BODY =
  'Acme Roofing checked the hail near you. 100 Main St, Omaha, NE 68102. Unsubscribe: https://app.example.com/u/abc123';

/** A marketing email that sends: billing ok, an address on file, consent not withdrawn, 10:00 in Chicago. */
function baseline(over: Partial<EmailGateRequest> = {}): EmailGateRequest {
  return {
    purpose: 'marketing',
    billingOk: true,
    email: 'maria@example.com',
    doNotContact: false,
    optedOut: false,
    subject: 'Hail near your home on Oak St',
    body: MARKETING_BODY,
    companyName: 'Acme Roofing',
    companyAddress: '100 Main St, Omaha, NE 68102',
    dedupeHit: false,
    sentLast7Days: 0,
    now: chi('2026-06-10T10:00:00'),
    timeZone: CHICAGO,
    ...over,
  };
}

/** The baseline with the moment moved to `nowIso` (a Chicago wall-clock time). */
const at = (nowIso: string, over: Partial<EmailGateRequest> = {}): EmailGateRequest =>
  baseline({ ...over, now: chi(nowIso) });

function blocked(r: EmailGateRequest) {
  const d = decideEmail(r);
  if (d.ok) throw new Error(`expected a block, got ${JSON.stringify(d)}`);
  expect(GATE_RULES).toContain(d.rule);
  return d;
}

describe('decideEmail: a clean marketing email', () => {
  test('sends now', () => {
    const now = chi('2026-06-10T10:00:00');
    const d = decideEmail(baseline({ now }));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.sendAt).toEqual(now);
  });
});

describe('decideEmail: billing and contact', () => {
  test('billing blocks when billing is not ok', () => {
    expect(blocked(baseline({ billingOk: false }))).toEqual({
      ok: false,
      rule: 'billing',
      reason: 'Email is paused until billing is sorted out.',
    });
  });

  test('contact blocks when there is no email address', () => {
    expect(blocked(baseline({ email: null }))).toEqual({
      ok: false,
      rule: 'contact',
      reason: 'No email address on file.',
    });
  });

  test('contact blocks an opted-out customer', () => {
    expect(blocked(baseline({ optedOut: true }))).toEqual({
      ok: false,
      rule: 'contact',
      reason: 'They unsubscribed from emails.',
    });
  });

  test('contact blocks a do-not-contact customer', () => {
    expect(blocked(baseline({ doNotContact: true })).rule).toBe('contact');
  });
});

describe('decideEmail: content', () => {
  const contentReason = 'Emails need the company name, mailing address and unsubscribe link.';
  const blankReason = 'This message still has a blank to fill in.';

  test('a marketing email without a postal address is blocked', () => {
    expect(blocked(baseline({ companyAddress: null }))).toEqual({ ok: false, rule: 'content', reason: contentReason });
  });

  test('a marketing body without the company name is blocked', () => {
    const r = blocked(baseline({ body: 'Hail near you. Unsubscribe: https://app.example.com/u/abc123' }));
    expect(r).toEqual({ ok: false, rule: 'content', reason: contentReason });
  });

  test('a body with neither an unsubscribe link nor {unsubscribe} is blocked', () => {
    const r = blocked(baseline({ body: 'Acme Roofing checked the hail near you.' }));
    expect(r).toEqual({ ok: false, rule: 'content', reason: contentReason });
  });

  test('a body with {unsubscribe} in place of a link passes', () => {
    const d = decideEmail(
      baseline({ body: 'Acme Roofing checked the hail near you. 100 Main St, Omaha, NE 68102. {unsubscribe}' }),
    );
    expect(d.ok).toBe(true);
  });

  test('a marketing body without the postal address is blocked, even with a name and unsubscribe link', () => {
    const r = blocked(baseline({ body: 'Acme Roofing checked the hail near you. Unsubscribe: https://app.example.com/u/abc123' }));
    expect(r).toEqual({ ok: false, rule: 'content', reason: contentReason });
  });

  test('a body with a leftover {street} token is blocked with the blank message', () => {
    const r = blocked(
      baseline({ body: 'Acme Roofing saw hail on {street}. 100 Main St, Omaha, NE 68102. Unsubscribe: https://app.example.com/u/abc123' }),
    );
    expect(r).toEqual({ ok: false, rule: 'content', reason: blankReason });
  });

  test('a subject with a leftover {first_name} token is blocked with the blank message', () => {
    const r = blocked(baseline({ subject: 'Hi {first_name}, hail near you' }));
    expect(r).toEqual({ ok: false, rule: 'content', reason: blankReason });
  });

  test('a leftover {unsubscribe} token is allowed, because the send swaps it for the link', () => {
    const d = decideEmail(
      baseline({ body: 'Acme Roofing checked the hail near you. 100 Main St, Omaha, NE 68102. {unsubscribe}' }),
    );
    expect(d.ok).toBe(true);
  });

  test('the address is matched after trimming surrounding whitespace', () => {
    const d = decideEmail(
      baseline({
        companyAddress: '  12 Main St, Tampa FL  ',
        body: 'Acme Roofing checked the hail near you. 12 Main St, Tampa FL. Unsubscribe: https://app.example.com/u/abc123',
      }),
    );
    expect(d.ok).toBe(true);
  });

  test('an informational email with a leftover {street} token is not blocked by the blank rule', () => {
    const d = decideEmail(
      baseline({ purpose: 'informational', body: 'Your crew arrives on {street} at 9am.' }),
    );
    expect(d.ok).toBe(true);
  });

  test('an informational email with no address and no unsubscribe passes', () => {
    const d = decideEmail(
      baseline({
        purpose: 'informational',
        companyAddress: null,
        body: 'Your crew arrives tomorrow at 9am.',
      }),
    );
    expect(d.ok).toBe(true);
  });

  test('a blank subject is blocked', () => {
    expect(blocked(baseline({ subject: '   ' })).rule).toBe('content');
  });
});

describe('decideEmail: dedupe and frequency', () => {
  test('a dedupe hit blocks with the dedupe message', () => {
    expect(blocked(baseline({ dedupeHit: true }))).toEqual({
      ok: false,
      rule: 'dedupe',
      reason: 'Already emailed about this.',
    });
  });

  test('two emails in the last seven days block with the frequency message', () => {
    expect(blocked(baseline({ sentLast7Days: 2 }))).toEqual({
      ok: false,
      rule: 'frequency',
      reason: 'Already got 2 emails this week.',
    });
  });

  test('one email in the last seven days still sends', () => {
    expect(decideEmail(baseline({ sentLast7Days: 1 })).ok).toBe(true);
  });

  test('an informational email is not held back by the weekly count', () => {
    const d = decideEmail(
      baseline({ purpose: 'informational', sentLast7Days: 5, body: 'Your crew arrives tomorrow at 9am.' }),
    );
    expect(d.ok).toBe(true);
  });
});

describe('decideEmail: rule order', () => {
  test.each([
    ['billing before contact', { billingOk: false, email: null }, 'billing'],
    ['contact before content', { email: null, companyAddress: null }, 'contact'],
    ['content before dedupe', { companyAddress: null, dedupeHit: true }, 'content'],
    ['dedupe before frequency', { dedupeHit: true, sentLast7Days: 2 }, 'dedupe'],
  ] as const)('%s', (_name, over, rule) => {
    expect(blocked(baseline(over as Partial<EmailGateRequest>)).rule).toBe(rule);
  });

  test('frequency is checked before quiet hours', () => {
    const d = blocked(at('2026-06-10T22:00:00', { sentLast7Days: 2 }));
    expect(d.rule).toBe('frequency');
  });
});

describe('decideEmail: quiet hours', () => {
  test('at 22:00 Chicago the email waits until 08:00 the next day', () => {
    const d = decideEmail(at('2026-06-10T22:00:00'));
    expect(d).toEqual({ ok: true, sendAt: chi('2026-06-11T08:00:00') });
  });

  test('at 06:00 Chicago the email goes out at 08:00 the same day', () => {
    const d = decideEmail(at('2026-06-10T06:00:00'));
    expect(d).toEqual({ ok: true, sendAt: chi('2026-06-10T08:00:00') });
  });

  test('at 20:59 Chicago the email goes out now', () => {
    const now = chi('2026-06-10T20:59:00');
    const d = decideEmail(at('2026-06-10T20:59:00'));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.sendAt).toEqual(now);
  });

  test('an unknown time zone throws a RangeError', () => {
    expect(() => decideEmail(baseline({ timeZone: 'Mars/Base' }))).toThrow(RangeError);
  });
});
