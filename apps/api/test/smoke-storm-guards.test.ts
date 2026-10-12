import { describe, expect, test } from 'vitest';
import { SmokeRefused } from '../src/scripts/smoke/guards.ts';
import {
  SMOKE_BUDGET_CENTS,
  STORM_CONFIRM_FLAG,
  assertGoogleSmokeAllowed,
  assertStormConfirmed,
  assertUnsubscribeLink,
  parseGoogleTestAccount,
  parseStormArgs,
  scrubFixture,
  smokeNameTag,
} from '../src/scripts/smoke/storm-guards.ts';

// Pure checks only: the storm smoke script is run by hand, never from the test suite.

function refusalOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('assertStormConfirmed', () => {
  test('refuses when the confirm flag is absent', () => {
    expect(() => assertStormConfirmed([])).toThrow(SmokeRefused);
  });

  test('the refusal names the confirm flag', () => {
    const err = refusalOf(() => assertStormConfirmed([]));
    expect(err).toBeInstanceOf(SmokeRefused);
    expect((err as Error).message).toContain('--confirm-real-providers');
  });

  test('accepts argv that includes the confirm flag', () => {
    expect(() => assertStormConfirmed([STORM_CONFIRM_FLAG])).not.toThrow();
    expect(() => assertStormConfirmed(['--google', '1234567890', '--confirm-real-providers'])).not.toThrow();
  });
});

describe('parseStormArgs', () => {
  test('defaults to all null and no spend understanding', () => {
    expect(parseStormArgs([])).toEqual({ google: null, meta: null, email: null, understandSpend: false });
  });

  test('strips dashes and spaces from a Google customer id', () => {
    expect(parseStormArgs(['--google', '123-456-7890']).google).toBe('1234567890');
    expect(parseStormArgs(['--google', '123 456 7890']).google).toBe('1234567890');
  });

  test('refuses a short Google customer id', () => {
    expect(() => parseStormArgs(['--google', '12'])).toThrow(SmokeRefused);
    expect(() => parseStormArgs(['--google', '12'])).toThrow('The --google value must be a 10-digit Google Ads customer id.');
  });

  test('normalises a Meta ad account id with or without act_', () => {
    expect(parseStormArgs(['--meta', '555']).meta).toBe('act_555');
    expect(parseStormArgs(['--meta', 'act_555']).meta).toBe('act_555');
  });

  test('refuses a Meta id that is not digits', () => {
    expect(() => parseStormArgs(['--meta', 'abc'])).toThrow(SmokeRefused);
    expect(() => parseStormArgs(['--meta', 'abc'])).toThrow(
      'The --meta value must be a Meta ad account id such as act_123.',
    );
  });

  test('accepts a valid email and refuses an invalid one', () => {
    expect(parseStormArgs(['--email', 'a@b.co']).email).toBe('a@b.co');
    expect(() => parseStormArgs(['--email', 'nope'])).toThrow(SmokeRefused);
    expect(() => parseStormArgs(['--email', 'nope'])).toThrow('The --email value must be an email address.');
  });

  test('refuses a value flag with no following value', () => {
    expect(() => parseStormArgs(['--google'])).toThrow(SmokeRefused);
    expect(() => parseStormArgs(['--google'])).toThrow('The --google flag needs a value.');
  });

  test('refuses a value flag whose next token is another flag', () => {
    expect(() => parseStormArgs(['--google', '--meta'])).toThrow(SmokeRefused);
    expect(() => parseStormArgs(['--google', '--meta'])).toThrow('The --google flag needs a value.');
  });

  test('reads the spend understanding flag as a boolean', () => {
    expect(parseStormArgs(['--i-understand-spend']).understandSpend).toBe(true);
  });

  test('ignores unknown flags', () => {
    expect(parseStormArgs(['--whatever', '--google', '1234567890']).google).toBe('1234567890');
  });

  test('refusal messages never contain the bad value', () => {
    const err = refusalOf(() => parseStormArgs(['--email', 'secret-value']));
    expect(err).toBeInstanceOf(SmokeRefused);
    expect((err as Error).message).not.toContain('secret-value');

    const meta = refusalOf(() => parseStormArgs(['--meta', 'secret-value']));
    expect((meta as Error).message).not.toContain('secret-value');

    const google = refusalOf(() => parseStormArgs(['--google', 'secret-value']));
    expect((google as Error).message).not.toContain('secret-value');
  });
});

describe('parseGoogleTestAccount', () => {
  test('is true for a Google Ads test account', () => {
    expect(parseGoogleTestAccount([{ customer: { testAccount: true } }])).toBe(true);
  });

  test('also accepts the snake_case field', () => {
    expect(parseGoogleTestAccount([{ customer: { test_account: true } }])).toBe(true);
  });

  test('is false for empty rows, missing fields, false and wrong types', () => {
    expect(parseGoogleTestAccount([])).toBe(false);
    expect(parseGoogleTestAccount([{}])).toBe(false);
    expect(parseGoogleTestAccount([{ customer: { testAccount: false } }])).toBe(false);
    expect(parseGoogleTestAccount([{ customer: { testAccount: 'true' } }])).toBe(false);
  });
});

describe('assertGoogleSmokeAllowed', () => {
  test('passes a test account without spend understanding', () => {
    expect(() =>
      assertGoogleSmokeAllowed({ isTestAccount: true, understandSpend: false, dailyBudgetCents: 0 }),
    ).not.toThrow();
  });

  test('passes a non-test account with spend understanding and a $1 budget', () => {
    expect(SMOKE_BUDGET_CENTS).toBe(100);
    expect(() =>
      assertGoogleSmokeAllowed({ isTestAccount: false, understandSpend: true, dailyBudgetCents: 100 }),
    ).not.toThrow();
  });

  test('refuses a non-test account with spend understanding but a larger budget', () => {
    expect(() =>
      assertGoogleSmokeAllowed({ isTestAccount: false, understandSpend: true, dailyBudgetCents: 101 }),
    ).toThrow(SmokeRefused);
  });

  test('refuses a non-test account without spend understanding', () => {
    expect(() =>
      assertGoogleSmokeAllowed({ isTestAccount: false, understandSpend: false, dailyBudgetCents: 100 }),
    ).toThrow(SmokeRefused);
  });
});

describe('smokeNameTag', () => {
  test('builds the tag from the platform and stamp', () => {
    expect(smokeNameTag('meta', '2026')).toBe('Roofline smoke meta 2026');
  });
});

describe('assertUnsubscribeLink', () => {
  const origin = 'https://app.example.com';
  const link = 'https://app.example.com/u/abc';

  test('passes when the text and html both contain the link', () => {
    expect(() =>
      assertUnsubscribeLink({ text: `Opt out: ${link}`, html: `<a href="${link}">Opt out</a>`, unsubscribeUrl: link }, origin),
    ).not.toThrow();
  });

  test('refuses an empty token', () => {
    const empty = 'https://app.example.com/u/';
    expect(() =>
      assertUnsubscribeLink({ text: empty, html: empty, unsubscribeUrl: empty }, origin),
    ).toThrow(SmokeRefused);
    expect(() =>
      assertUnsubscribeLink({ text: empty, html: empty, unsubscribeUrl: empty }, origin),
    ).toThrow('The broadcast email has no working unsubscribe link, so it was not sent.');
  });

  test('refuses a link from a different origin', () => {
    expect(() =>
      assertUnsubscribeLink(
        { text: 'https://other.example.org/u/abc', html: 'https://other.example.org/u/abc', unsubscribeUrl: 'https://other.example.org/u/abc' },
        origin,
      ),
    ).toThrow(SmokeRefused);
  });

  test('refuses when the html lacks the link', () => {
    expect(() =>
      assertUnsubscribeLink({ text: link, html: '<p>No link here</p>', unsubscribeUrl: link }, origin),
    ).toThrow(SmokeRefused);
  });
});

describe('scrubFixture', () => {
  test('scrubs secret and personal keys and keeps numeric keys', () => {
    const out = scrubFixture({
      access_token: 'x',
      data: [{ email: 'a@b.co', spendCents: 5 }],
    });
    expect(out).toEqual({
      access_token: '[scrubbed]',
      data: [{ email: '[scrubbed]', spendCents: 5 }],
    });
  });

  test('does not mutate the input', () => {
    const input = { access_token: 'x', data: [{ email: 'a@b.co', spendCents: 5 }] };
    const snapshot = JSON.parse(JSON.stringify(input));
    scrubFixture(input);
    expect(input).toEqual(snapshot);
  });

  test('scrubs a standalone email string', () => {
    expect(scrubFixture('a@b.co')).toBe('[scrubbed]');
  });

  test('scrubs a long token string', () => {
    expect(scrubFixture('a'.repeat(40))).toBe('[scrubbed]');
    expect(scrubFixture(`Bearer ${'a'.repeat(40)}`)).toBe('[scrubbed]');
  });

  test('keeps numbers, booleans and null', () => {
    expect(scrubFixture({ impressions: 12, ok: true, nothing: null })).toEqual({
      impressions: 12,
      ok: true,
      nothing: null,
    });
  });
});
