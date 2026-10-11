import { DateTime } from 'luxon';
import { describe, expect, test } from 'vitest';
import { nextAllowedTime } from '../src/index.ts';

const CHICAGO = 'America/Chicago';

/** A wall-clock moment in `zone`, as a Date. */
const local = (iso: string, zone = CHICAGO): Date => DateTime.fromISO(iso, { zone }).toJSDate();

describe('nextAllowedTime', () => {
  test('inside the window it returns the time it was given', () => {
    const t = local('2026-06-10T13:45:12.250');
    expect(nextAllowedTime(t, CHICAGO, 'NE')).toEqual(t);
  });

  test('exactly 08:00 is allowed; one millisecond before is not', () => {
    const start = local('2026-06-10T08:00:00');
    expect(nextAllowedTime(start, CHICAGO, null)).toEqual(start);
    expect(nextAllowedTime(new Date(start.getTime() - 1), CHICAGO, null)).toEqual(start);
  });

  test('before the start it waits for 08:00 the same day', () => {
    expect(nextAllowedTime(local('2026-06-10T00:00:00'), CHICAGO, null)).toEqual(local('2026-06-10T08:00:00'));
    expect(nextAllowedTime(local('2026-06-10T07:59:59'), CHICAGO, null)).toEqual(local('2026-06-10T08:00:00'));
  });

  test('at or after the end it waits for 08:00 tomorrow', () => {
    const tomorrow = local('2026-06-11T08:00:00');
    expect(nextAllowedTime(local('2026-06-10T20:59:59.999'), CHICAGO, null)).toEqual(local('2026-06-10T20:59:59.999'));
    expect(nextAllowedTime(local('2026-06-10T21:00:00'), CHICAGO, null)).toEqual(tomorrow);
    expect(nextAllowedTime(local('2026-06-10T23:59:59'), CHICAGO, null)).toEqual(tomorrow);
  });

  test('rolls over month and year ends', () => {
    expect(nextAllowedTime(local('2026-12-31T22:00:00'), CHICAGO, null)).toEqual(local('2027-01-01T08:00:00'));
  });

  test('FL, OK and MD end at 20:00, however the state is written', () => {
    const tomorrow = local('2026-06-11T08:00:00');
    for (const state of ['FL', 'OK', 'MD', 'fl', ' Md ']) {
      expect(nextAllowedTime(local('2026-06-10T19:59:00'), CHICAGO, state)).toEqual(local('2026-06-10T19:59:00'));
      expect(nextAllowedTime(local('2026-06-10T20:00:00'), CHICAGO, state)).toEqual(tomorrow);
    }
  });

  test('a missing or unknown state gets the standard 21:00 end', () => {
    for (const state of [null, '', 'NE', 'TX', 'Florida']) {
      expect(nextAllowedTime(local('2026-06-10T20:30:00'), CHICAGO, state)).toEqual(local('2026-06-10T20:30:00'));
    }
  });

  test('works in the zone it is given, not the machine zone', () => {
    // 2026-06-10 03:30Z is 20:30 the night before in Los Angeles, 05:30 in Berlin.
    const t = new Date('2026-06-10T03:30:00Z');
    expect(nextAllowedTime(t, 'America/Los_Angeles', null)).toEqual(t);
    expect(nextAllowedTime(t, 'America/Los_Angeles', 'FL')).toEqual(local('2026-06-10T08:00:00', 'America/Los_Angeles'));
    expect(nextAllowedTime(t, 'Europe/Berlin', null)).toEqual(local('2026-06-10T08:00:00', 'Europe/Berlin'));
  });

  test('falls back to the standard window when no zone or state is known (company zone, 21:00 end)', () => {
    // The recipient's missing zone and state are resolved by decide() to the company zone and null.
    expect(nextAllowedTime(local('2026-06-10T20:59:00'), CHICAGO, null)).toEqual(local('2026-06-10T20:59:00'));
    expect(nextAllowedTime(local('2026-06-10T21:01:00'), CHICAGO, null)).toEqual(local('2026-06-11T08:00:00'));
  });

  test('throws for a time zone it does not know, rather than guessing', () => {
    expect(() => nextAllowedTime(new Date(), 'Not/AZone', null)).toThrow(/time zone/i);
  });

  test('throws for an invalid date', () => {
    expect(() => nextAllowedTime(new Date('nope'), CHICAGO, null)).toThrow();
  });
});

describe('daylight saving time (America/Chicago)', () => {
  test('spring forward, 2026-03-08: 07:30 local waits for 08:00 local the same day', () => {
    const t = local('2026-03-08T07:30:00');
    const next = nextAllowedTime(t, CHICAGO, null);
    expect(next).toEqual(local('2026-03-08T08:00:00'));
    const asLocal = DateTime.fromJSDate(next, { zone: CHICAGO });
    expect(asLocal.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-03-08 08:00');
    expect(asLocal.offset).toBe(-300); // already CDT; the 02:00 hour was skipped
    // Only 30 minutes of real time pass: 07:30 CDT to 08:00 CDT.
    expect(next.getTime() - t.getTime()).toBe(30 * 60_000);
  });

  test('spring forward: a request the evening before waits through the short night to 08:00 CDT', () => {
    const next = nextAllowedTime(local('2026-03-07T21:30:00'), CHICAGO, null);
    expect(next).toEqual(local('2026-03-08T08:00:00'));
    // 21:30 CST to 08:00 CDT is 10h30m on the wall clock, but an hour of it is skipped: 9h30m real.
    expect(next.getTime() - local('2026-03-07T21:30:00').getTime()).toBe((10 * 60 + 30 - 60) * 60_000);
  });

  test('fall back, 2026-11-01: 21:05 local waits for 08:00 local the next day', () => {
    const t = local('2026-11-01T21:05:00');
    const next = nextAllowedTime(t, CHICAGO, null);
    expect(next).toEqual(local('2026-11-02T08:00:00'));
    expect(DateTime.fromJSDate(next, { zone: CHICAGO }).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-11-02 08:00');
    expect(DateTime.fromJSDate(next, { zone: CHICAGO }).offset).toBe(-360); // CST
    // 21:05 CST to 08:00 CST: 10h55m of real time.
    expect(next.getTime() - t.getTime()).toBe((10 * 60 + 55) * 60_000);
  });

  test('fall back: a request the evening before waits through the long night to 08:00 CST', () => {
    const t = local('2026-10-31T21:30:00');
    expect(nextAllowedTime(t, CHICAGO, null)).toEqual(local('2026-11-01T08:00:00'));
    expect(nextAllowedTime(t, CHICAGO, null).getTime() - t.getTime()).toBe((10 * 60 + 30 + 60) * 60_000);
  });

  test('fall back: both 01:30s of the repeated hour are before 08:00 and wait for it', () => {
    const first = new Date('2026-11-01T06:30:00Z'); // 01:30 CDT
    const second = new Date('2026-11-01T07:30:00Z'); // 01:30 CST
    expect(nextAllowedTime(first, CHICAGO, null)).toEqual(local('2026-11-01T08:00:00'));
    expect(nextAllowedTime(second, CHICAGO, null)).toEqual(local('2026-11-01T08:00:00'));
  });

  test('inside the window on a DST day returns the instant unchanged', () => {
    for (const iso of ['2026-03-08T12:00:00', '2026-11-01T12:00:00']) {
      expect(nextAllowedTime(local(iso), CHICAGO, null)).toEqual(local(iso));
    }
  });

  test('Florida end of 20:00 holds on the fall-back day too', () => {
    expect(nextAllowedTime(local('2026-11-01T20:05:00'), CHICAGO, 'FL')).toEqual(local('2026-11-02T08:00:00'));
  });
});
