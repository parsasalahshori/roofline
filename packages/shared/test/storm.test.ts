import { describe, expect, test } from 'vitest';
import {
  DEFAULT_STORM_EMAIL_BODY,
  DEFAULT_STORM_EMAIL_SUBJECT,
  DEFAULT_STORM_SMS,
  HAIL_LEVELS_IN,
  dailyBudgetCents,
  hailInches,
  hailLabel,
  hexCenterSpacingM,
  isYesReply,
  missingStormTokens,
  nextCircleRadiusM,
  renderStormTemplate,
  splitAdBudget,
  stormDayLabel,
  stormTitle,
} from '../src/storm.ts';
import * as index from '../src/index.ts';
import * as storm from '../src/storm.ts';

const FIELDS = {
  first_name: 'Dana',
  company: 'Acme Roofing',
  hail_size: '1.75"',
  street: 'Elm St',
  day: 'yesterday',
};

describe('storm exports', () => {
  test('every storm name is exported from the package entry point and equals the storm.ts export', () => {
    const names = [
      'DEFAULT_STORM_SMS',
      'DEFAULT_STORM_EMAIL_SUBJECT',
      'DEFAULT_STORM_EMAIL_BODY',
      'renderStormTemplate',
      'missingStormTokens',
      'hailLabel',
      'hailInches',
      'stormTitle',
      'isYesReply',
      'splitAdBudget',
      'dailyBudgetCents',
      'nextCircleRadiusM',
      'hexCenterSpacingM',
      'stormDayLabel',
    ] as const;
    for (const name of names) {
      expect(index[name], name).toBeDefined();
      expect(index[name], name).toBe(storm[name]);
    }
  });

  test('HAIL_LEVELS_IN is unchanged', () => {
    expect([...HAIL_LEVELS_IN]).toEqual([0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]);
  });
});

describe('renderStormTemplate', () => {
  test('fills the default SMS exactly', () => {
    expect(renderStormTemplate(DEFAULT_STORM_SMS, FIELDS)).toBe(
      "Hi Dana, it's Acme Roofing. Radar shows hail up to 1.75\" hit near your home on Elm St yesterday. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.",
    );
  });

  test.each(['', '  '])('a first_name of %j renders "there"', (first) => {
    expect(renderStormTemplate('Hi {first_name},', { ...FIELDS, first_name: first })).toBe('Hi there,');
  });

  test('leaves unknown tokens and wrong-case tokens as written', () => {
    expect(renderStormTemplate('{foo} and {Company}', FIELDS)).toBe('{foo} and {Company}');
  });

  test('inserts a first_name that looks like a token literally, without re-reading it', () => {
    expect(renderStormTemplate('Hi {first_name} from {company}', { ...FIELDS, first_name: '{company}' })).toBe(
      'Hi {company} from Acme Roofing',
    );
  });

  test('inserts $ sequences in values literally', () => {
    expect(renderStormTemplate('Hi {first_name}', { ...FIELDS, first_name: '$&' })).toBe('Hi $&');
    expect(renderStormTemplate('{company}', { ...FIELDS, company: "Ace $1 $' $$" })).toBe("Ace $1 $' $$");
  });

  test('replaces every occurrence of a token', () => {
    expect(renderStormTemplate('{street} and {street}', FIELDS)).toBe('Elm St and Elm St');
  });

  test('renders the email subject', () => {
    expect(renderStormTemplate(DEFAULT_STORM_EMAIL_SUBJECT, FIELDS)).toBe('Hail near your home on Elm St');
  });

  test('renders the email body with company_address and unsubscribe', () => {
    const body = renderStormTemplate(DEFAULT_STORM_EMAIL_BODY, {
      ...FIELDS,
      company_address: '1 Main St, Omaha, NE',
      unsubscribe: 'https://x.test/u/abc',
    });
    expect(body).toContain('1 Main St, Omaha, NE');
    expect(body).toContain('https://x.test/u/abc');
    expect(body).not.toContain('{');
  });

  test('leaves company_address and unsubscribe tokens in place when absent', () => {
    const body = renderStormTemplate(DEFAULT_STORM_EMAIL_BODY, FIELDS);
    expect(body).toContain('{company_address}');
    expect(body).toContain('{unsubscribe}');
  });
});

describe('missingStormTokens', () => {
  test('the default SMS is complete', () => {
    expect(missingStormTokens(DEFAULT_STORM_SMS, 'sms')).toEqual([]);
  });

  test('the default email body is complete', () => {
    expect(missingStormTokens(DEFAULT_STORM_EMAIL_BODY, 'email')).toEqual([]);
  });

  test('the default email body contains the three required tokens', () => {
    expect(DEFAULT_STORM_EMAIL_BODY).toContain('{company}');
    expect(DEFAULT_STORM_EMAIL_BODY).toContain('{company_address}');
    expect(DEFAULT_STORM_EMAIL_BODY).toContain('{unsubscribe}');
  });

  test('an SMS without {company} is flagged', () => {
    expect(missingStormTokens('Hi {first_name} reply STOP', 'sms')).toEqual(['{company}']);
  });

  test('an SMS without Reply STOP is flagged', () => {
    expect(missingStormTokens('Hi from {company}', 'sms')).toEqual(['Reply STOP']);
  });

  test('an empty SMS flags both requirements in order', () => {
    expect(missingStormTokens('', 'sms')).toEqual(['{company}', 'Reply STOP']);
  });

  test('Reply STOP is matched case-insensitively', () => {
    expect(missingStormTokens('Hi {company}, reply stop to opt out', 'sms')).toEqual([]);
  });

  test('an email with no required tokens flags all three', () => {
    expect(missingStormTokens('hello', 'email')).toEqual(['{company}', '{company_address}', '{unsubscribe}']);
  });

  test('an email missing only {unsubscribe} flags only that', () => {
    expect(missingStormTokens('{company} {company_address}', 'email')).toEqual(['{unsubscribe}']);
  });
});

describe('hailLabel and stormTitle', () => {
  test.each([
    [1.75, '1.75"'],
    [1, '1"'],
    [1.5, '1.5"'],
    [0.75, '0.75"'],
    [2.5, '2.5"'],
  ])('hailLabel(%s) is %j', (inches, label) => {
    expect(hailLabel(inches)).toBe(label);
  });

  test.each([
    [1.75, '1.75 in'],
    [1, '1 in'],
    [0.75, '0.75 in'],
  ])('hailInches(%s) is %j', (inches, label) => {
    expect(hailInches(inches)).toBe(label);
  });

  test('stormTitle with a place name', () => {
    expect(stormTitle('Omaha, NE', 1.75)).toBe('Storm plan for hail near Omaha, NE (up to 1.75 in)');
  });

  test('stormTitle without a place name', () => {
    expect(stormTitle(null, 1)).toBe('Storm plan for hail (up to 1 in)');
  });
});

describe('isYesReply', () => {
  test.each([
    'yes',
    'Yes',
    'YES!',
    'y',
    ' Y ',
    'yeah',
    'Yeah.',
    'yep',
    'sure',
    'Sure!',
    'ok',
    'OK',
    'okay',
    'Okay!',
    'please',
    'Please.',
    'book',
    'Book',
    '\u{1F44D}',
    '\u{1F44D}\u{1F3FD}',
  ])('treats %j as a yes', (body) => {
    expect(isYesReply(body)).toBe(true);
  });

  test.each([
    'yes stop',
    'no',
    'stop',
    '',
    '   ',
    'yes please call me',
    'yesterday',
    'maybe',
    'y es',
    'yes, thanks',
    'STOP',
    'not ok',
  ])('treats %j as not a yes', (body) => {
    expect(isYesReply(body)).toBe(false);
  });
});

describe('splitAdBudget', () => {
  test('splits 27000 cents at 60% Google', () => {
    expect(splitAdBudget(27000, 60)).toEqual({ google: 16200, meta: 10800 });
  });

  const totals = [0, 1, 99, 101, 27000, 99999];
  const pcts = [0, 1, 33, 50, 60, 100];
  for (const total of totals) {
    for (const pct of pcts) {
      test(`(${total}, ${pct}) sums to the total with non-negative integers`, () => {
        const { google, meta } = splitAdBudget(total, pct);
        expect(google + meta).toBe(total);
        expect(Number.isInteger(google)).toBe(true);
        expect(Number.isInteger(meta)).toBe(true);
        expect(google).toBeGreaterThanOrEqual(0);
        expect(meta).toBeGreaterThanOrEqual(0);
      });
    }
  }

  test('0% Google gives everything to Meta', () => {
    expect(splitAdBudget(1000, 0)).toEqual({ google: 0, meta: 1000 });
  });

  test('100% Google gives everything to Google', () => {
    expect(splitAdBudget(1000, 100)).toEqual({ google: 1000, meta: 0 });
  });

  test('rounds a half cent to Google', () => {
    expect(splitAdBudget(101, 50)).toEqual({ google: 51, meta: 50 });
  });
});

describe('dailyBudgetCents', () => {
  test('27000 cents over 7 days is 3857 a day', () => {
    expect(dailyBudgetCents(27000, 7)).toBe(3857);
    expect(dailyBudgetCents(27000, 7) * 7).toBeLessThanOrEqual(27000);
  });

  test.each([
    [27000, 7],
    [1000, 3],
    [99999, 30],
    [1, 2],
    [500, 1],
    [12345, 14],
  ])('daily * days <= max for (%i, %i)', (max, days) => {
    expect(dailyBudgetCents(max, days) * days).toBeLessThanOrEqual(max);
  });

  test('zero days gives zero', () => {
    expect(dailyBudgetCents(1000, 0)).toBe(0);
  });
});

describe('circle radius math', () => {
  test.each([
    [0, 1000],
    [1000, 2000],
    [2000, 4000],
    [1609, 3218],
    [400, 1000],
  ])('nextCircleRadiusM(%i) is %i', (prev, next) => {
    expect(nextCircleRadiusM(prev)).toBe(next);
  });

  test('hexCenterSpacingM(1000) is about 1732.0508', () => {
    expect(hexCenterSpacingM(1000)).toBeCloseTo(1732.0508, 3);
  });

  test('hexCenterSpacingM(0) is 0', () => {
    expect(hexCenterSpacingM(0)).toBe(0);
  });
});

describe('stormDayLabel', () => {
  const CHICAGO = 'America/Chicago';

  describe('America/Chicago, instant 2026-10-12T04:30Z (Oct 11 locally)', () => {
    const now = new Date('2026-10-12T04:30:00Z');
    test('the local day is today', () => {
      expect(stormDayLabel('2026-10-11', now, CHICAGO)).toBe('today');
    });
    test('the day before is yesterday', () => {
      expect(stormDayLabel('2026-10-10', now, CHICAGO)).toBe('yesterday');
    });
    test('an older day gives its weekday', () => {
      expect(stormDayLabel('2026-10-06', now, CHICAGO)).toBe('on Tuesday');
    });
  });

  describe('America/Chicago, instant 2026-10-12T05:30Z (Oct 12 locally)', () => {
    const now = new Date('2026-10-12T05:30:00Z');
    test('the local day is today', () => {
      expect(stormDayLabel('2026-10-12', now, CHICAGO)).toBe('today');
    });
    test('the day before is yesterday', () => {
      expect(stormDayLabel('2026-10-11', now, CHICAGO)).toBe('yesterday');
    });
    test('an older day gives its weekday', () => {
      expect(stormDayLabel('2026-10-10', now, CHICAGO)).toBe('on Saturday');
    });
  });

  describe('UTC, instant 2026-10-12T04:30Z (Oct 12 in UTC)', () => {
    const now = new Date('2026-10-12T04:30:00Z');
    test('the UTC day is today', () => {
      expect(stormDayLabel('2026-10-12', now, 'UTC')).toBe('today');
    });
    test('the day before is yesterday', () => {
      expect(stormDayLabel('2026-10-11', now, 'UTC')).toBe('yesterday');
    });
  });
});
