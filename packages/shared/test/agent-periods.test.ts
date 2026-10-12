import { describe, expect, test } from 'vitest';
import { localDate } from '../src/time-zone.ts';
import { addDays, chartDates, metricsWindow, periodRange, startOfLocalDay } from '../src/agent-periods.ts';

const CHICAGO = 'America/Chicago';
const NOW = new Date('2026-10-12T18:00:00Z'); // 13:00 CDT on Oct 12

describe('startOfLocalDay', () => {
  test('Chicago in daylight time starts at 05:00Z', () => {
    expect(startOfLocalDay('2026-10-12', CHICAGO).toISOString()).toBe('2026-10-12T05:00:00.000Z');
  });

  test('DST end day (Nov 1) starts at 05:00Z, the day after at 06:00Z', () => {
    expect(startOfLocalDay('2026-11-01', CHICAGO).toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(startOfLocalDay('2026-11-02', CHICAGO).toISOString()).toBe('2026-11-02T06:00:00.000Z');
  });

  test('DST start day (Mar 8) starts at 06:00Z, the day after at 05:00Z', () => {
    expect(startOfLocalDay('2026-03-08', CHICAGO).toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(startOfLocalDay('2026-03-09', CHICAGO).toISOString()).toBe('2026-03-09T05:00:00.000Z');
  });

  test('UTC is midnight UTC', () => {
    expect(startOfLocalDay('2026-10-12', 'UTC').toISOString()).toBe('2026-10-12T00:00:00.000Z');
  });

  test('Auckland (ahead of UTC) starts the local day in the previous UTC day', () => {
    // NZDT (+13) in October: local midnight is 11:00Z the day before.
    expect(startOfLocalDay('2026-10-12', 'Pacific/Auckland').toISOString()).toBe('2026-10-11T11:00:00.000Z');
  });
});

describe('startOfLocalDay at midnight DST jumps and US zones', () => {
  const localHour = (d: Date, zone: string): string =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' }).format(d);

  test('America/Santiago 2026-09-06 starts at 01:00 local (midnight does not exist)', () => {
    const start = startOfLocalDay('2026-09-06', 'America/Santiago');
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(localDate(start, 'America/Santiago')).toBe('2026-09-06');
    expect(localHour(start, 'America/Santiago')).toBe('01:00');
    expect(localDate(new Date(start.getTime() - 1000), 'America/Santiago')).toBe('2026-09-05');
  });

  test('America/Havana 2026-03-08 starts at 01:00 local', () => {
    const start = startOfLocalDay('2026-03-08', 'America/Havana');
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(localHour(start, 'America/Havana')).toBe('01:00');
  });

  test('US zones', () => {
    expect(startOfLocalDay('2026-03-08', 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(startOfLocalDay('2026-11-01', 'America/Chicago').toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(startOfLocalDay('2026-07-01', 'America/Los_Angeles').toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });
});

describe('addDays', () => {
  test('crosses month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-12', 0)).toBe('2026-10-12');
  });
});

describe('metricsWindow', () => {
  test('Chicago at 18:00Z on Oct 12', () => {
    const w = metricsWindow(NOW, CHICAGO);
    expect(w.timeZone).toBe(CHICAGO);
    expect(w.todayStart.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(w.tomorrowStart.toISOString()).toBe('2026-10-13T05:00:00.000Z');
    expect(w.monthStart.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(w.chartStart.toISOString()).toBe('2026-09-29T05:00:00.000Z');
    expect(w.since30.toISOString()).toBe('2026-09-12T18:00:00.000Z');
  });

  test('04:30Z on Oct 12 is still Oct 11 in Chicago', () => {
    const w = metricsWindow(new Date('2026-10-12T04:30:00Z'), CHICAGO);
    expect(w.todayStart.toISOString()).toBe('2026-10-11T05:00:00.000Z');
    expect(w.tomorrowStart.toISOString()).toBe('2026-10-12T05:00:00.000Z');
  });
});

describe('periodRange', () => {
  test('today is [todayStart, tomorrowStart)', () => {
    const r = periodRange(NOW, CHICAGO, 'today');
    expect(r.from.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });

  test('week for Monday Oct 12 runs to the next Monday', () => {
    const r = periodRange(NOW, CHICAGO, 'week');
    expect(r.from.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-19T05:00:00.000Z');
  });

  test('week for Sunday Oct 18 is the same Monday-start week', () => {
    const r = periodRange(new Date('2026-10-18T18:00:00Z'), CHICAGO, 'week');
    expect(r.from.toISOString()).toBe('2026-10-12T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-19T05:00:00.000Z');
  });

  test('month is the local month', () => {
    const r = periodRange(NOW, CHICAGO, 'month');
    expect(r.from.toISOString()).toBe('2026-10-01T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });

  test('month of December rolls into January', () => {
    const r = periodRange(new Date('2026-12-15T12:00:00Z'), CHICAGO, 'month');
    expect(r.from.toISOString()).toBe('2026-12-01T06:00:00.000Z');
    expect(r.to.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  test('last90 covers 90 local days including today', () => {
    const r = periodRange(NOW, CHICAGO, 'last90');
    expect(r.from.toISOString()).toBe('2026-07-15T05:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-10-13T05:00:00.000Z');
  });
});

describe('chartDates', () => {
  test('14 local dates, oldest first, ending today', () => {
    const dates = chartDates(NOW, CHICAGO);
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe('2026-09-29');
    expect(dates[13]).toBe('2026-10-12');
    expect(dates).toEqual(
      Array.from({ length: 14 }, (_, i) => addDays('2026-09-29', i)),
    );
  });
});
