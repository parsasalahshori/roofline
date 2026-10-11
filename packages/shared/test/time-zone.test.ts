import { describe, expect, test } from 'vitest';
import { isTimeZone, localDate } from '../src/time-zone.ts';
import { isTimeZone as isTimeZoneFromIndex, localDate as localDateFromIndex } from '../src/index.ts';

describe('isTimeZone', () => {
  test('is exported from the package entry point', () => {
    expect(isTimeZoneFromIndex).toBe(isTimeZone);
  });

  test.each(['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/Berlin', 'UTC'])(
    'accepts %s',
    (zone) => expect(isTimeZone(zone)).toBe(true),
  );

  test.each(['-06:00', '+05:00', '+0500', '+05', '-6', 'UTC+5', 'UTC-06:00', 'GMT+5', 'Etc/GMT+5'])(
    'rejects the fixed offset %s',
    (zone) => expect(isTimeZone(zone)).toBe(false),
  );

  test.each(['', ' ', 'local', 'system', 'Z', 'Not/AZone', 'Chicago', 'America/', '/Chicago', 'America/Chicago '])(
    'rejects %j',
    (zone) => expect(isTimeZone(zone)).toBe(false),
  );

  test('rejects things that are not strings', () => {
    for (const bad of [undefined, null, 5, {}]) {
      expect(isTimeZone(bad as unknown as string)).toBe(false);
    }
  });

  // Intl.supportedValuesOf lists ICU's older spellings (America/Indianapolis, Asia/Calcutta), so a
  // current IANA name like America/Indiana/Indianapolis is missing from it even though it is a
  // real place. These zones must still work: an Indiana customer must not be dropped to the
  // company's zone and texted in the wrong hours, and an Indiana roofer must be able to save theirs.
  test.each([
    'America/Indiana/Indianapolis',
    'America/Kentucky/Louisville',
    'Asia/Kolkata',
    'Europe/Kyiv',
    'America/Argentina/Buenos_Aires',
    'US/Central',
  ])('accepts %s, a current or alias name for a real zone', (zone) => {
    expect(isTimeZone(zone)).toBe(true);
  });
});

describe('localDate', () => {
  test('is exported from the package entry point', () => {
    expect(localDateFromIndex).toBe(localDate);
  });

  test('is the calendar day in the zone, not in UTC', () => {
    const instant = new Date('2026-10-12T04:30:00Z');
    expect(localDate(instant, 'America/Chicago')).toBe('2026-10-11');
    expect(localDate(instant, 'Asia/Tokyo')).toBe('2026-10-12');
    expect(localDate(instant, 'UTC')).toBe('2026-10-12');
  });

  test('turns over at local midnight, daylight saving included', () => {
    // Chicago is UTC-5 until Nov 1 2026 (CDT), UTC-6 after (CST).
    expect(localDate(new Date('2026-10-13T04:59:59Z'), 'America/Chicago')).toBe('2026-10-12');
    expect(localDate(new Date('2026-10-13T05:00:00Z'), 'America/Chicago')).toBe('2026-10-13');
    expect(localDate(new Date('2026-11-02T05:59:59Z'), 'America/Chicago')).toBe('2026-11-01');
    expect(localDate(new Date('2026-11-02T06:00:00Z'), 'America/Chicago')).toBe('2026-11-02');
  });
});
