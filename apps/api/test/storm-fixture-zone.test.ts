import { describe, expect, test } from 'vitest';
import { daytimeZone, localHour } from '../src/scripts/storm-fixture.ts';

describe('storm fixture daytimeZone', () => {
  test('every hour of the year gets a zone where it is 9 to 19 local', () => {
    for (const month of [0, 3, 6, 9]) {
      for (let hour = 0; hour < 24; hour++) {
        for (const minute of [0, 30, 59]) {
          const now = new Date(Date.UTC(2026, month, 15, hour, minute));
          const zone = daytimeZone(now);
          const local = localHour(now, zone);
          expect(local, `${now.toISOString()} -> ${zone}`).toBeGreaterThanOrEqual(9);
          expect(local, `${now.toISOString()} -> ${zone}`).toBeLessThanOrEqual(19);
        }
      }
    }
  });

  test('keeps Chicago when it is already daytime there', () => {
    expect(daytimeZone(new Date(Date.UTC(2026, 6, 15, 18, 0)))).toBe('America/Chicago');
  });
});
