import { describe, expect, test } from 'vitest';
import { isTimeZone } from '../src/time-zone.ts';
import { isTimeZone as isTimeZoneFromIndex } from '../src/index.ts';

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
