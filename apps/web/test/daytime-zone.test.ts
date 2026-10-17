import { describe, expect, test } from 'vitest';
import { daytimeZone } from '../e2e/daytime-zone.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();
function hourIn(zone: string, at: Date): number {
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' });
    formatters.set(zone, format);
  }
  return Number(format.format(at));
}

describe('the Front Desk e2e daytime zone', () => {
  test('there is a zone where it is between 10:00 and 17:59 at every half hour of the year, summer and winter', () => {
    const start = Date.UTC(2026, 0, 1);
    const end = Date.UTC(2027, 0, 1);
    for (let t = start; t < end; t += 30 * 60 * 1000) {
      const at = new Date(t);
      const zone = daytimeZone(at);
      const hour = hourIn(zone, at);
      if (hour < 10 || hour > 17) throw new Error(`${at.toISOString()}: ${zone} reads ${hour}:xx`);
    }
  });

  test('it picks the same zone for the same moment', () => {
    const at = new Date('2026-10-17T04:14:55.000Z');
    expect(daytimeZone(at)).toBe(daytimeZone(at));
    // 04:14 UTC is 9:14 PM in Los Angeles and 11:14 PM in Chicago: the US zones are all outside the window
    expect(hourIn(daytimeZone(at), at)).toBe(13);
  });
});
