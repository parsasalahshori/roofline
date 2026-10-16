import { describe, expect, test } from 'vitest';
import {
  downloadedContentDue,
  GOOGLE_CONTENT_MAX_DAYS,
  googleContentDue,
  googleDeleteBy,
  measurementGoogleDeleteBy,
  parseRetentionDays,
  retentionCutoff,
} from '../src/google-retention.ts';

const DAY = 86_400_000;
const T0 = '2026-10-12T15:00:00.000Z';
const at = (days: number) => new Date(Date.parse(T0) + days * DAY);

describe('Google content retention math', () => {
  test('the most is 30 days; the setting is a whole number from 1 to 30, unset or blank meaning 30', () => {
    expect(GOOGLE_CONTENT_MAX_DAYS).toBe(30);
    expect(parseRetentionDays(undefined)).toBe(30);
    expect(parseRetentionDays(' ')).toBe(30);
    expect(parseRetentionDays('7')).toBe(7);
    expect(parseRetentionDays(1)).toBe(1);
    for (const bad of ['0', '31', '-1', '2.5', 'thirty', 45]) expect(() => parseRetentionDays(bad)).toThrow(/1 to 30/);
  });

  test('a delete-by date is the download plus 30 days; an unreadable download has none', () => {
    expect(googleDeleteBy(T0)?.toISOString()).toBe(at(30).toISOString());
    expect(googleDeleteBy(new Date(T0))?.toISOString()).toBe(at(30).toISOString());
    expect(googleDeleteBy('soon')).toBeNull();
    expect(googleDeleteBy(null)).toBeNull();
  });

  test('due at the stored date with 30 days kept, that many days earlier with fewer', () => {
    const by = at(30);
    expect(googleContentDue(by, at(29.99))).toBe(false);
    expect(googleContentDue(by, at(30))).toBe(true);
    expect(retentionCutoff(at(0), 30).toISOString()).toBe(at(0).toISOString());
    expect(retentionCutoff(at(0), 7).toISOString()).toBe(at(23).toISOString());
    expect(googleContentDue(by, at(6.99), 7)).toBe(false);
    expect(googleContentDue(by, at(7), 7)).toBe(true);
    // Unreadable: due (the strict reading).
    expect(googleContentDue('garbled', at(0))).toBe(true);
    expect(downloadedContentDue(T0, at(29))).toBe(false);
    expect(downloadedContentDue(T0, at(30))).toBe(true);
    expect(downloadedContentDue(T0, at(3), 3)).toBe(true);
  });

  test("a measurement's date is the earlier of its Solar answer's and its roof photo's; our own roof alone has none", () => {
    const solar = { fetchedAt: at(-5).toISOString(), building: { segments: [] } };
    const roof = { fetchedAt: T0, photo: { key: 'roof-photos/x.png' } };
    expect(measurementGoogleDeleteBy(solar, roof)?.toISOString()).toBe(at(25).toISOString());
    expect(measurementGoogleDeleteBy(null, roof)?.toISOString()).toBe(at(30).toISOString());
    // "No building there" holds nothing of Google's; a 3D roof with no photo is ours alone.
    expect(measurementGoogleDeleteBy({ fetchedAt: T0, building: null }, { fetchedAt: T0, photo: null })).toBeNull();
    expect(measurementGoogleDeleteBy(null, { fetchedAt: T0 })).toBeNull();
  });
});
