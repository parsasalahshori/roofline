import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DURATION_MINUTES,
  DEFAULT_WORK_HOURS,
  MAX_AVAILABILITY_DAYS,
  SLOT_STEP_MINUTES,
  WorkHoursSchema,
  findSlots,
  mergeIntervals,
  workIntervals,
} from '../src/availability.ts';
import type { BusyItem, Interval, SlotQuery, WorkHours } from '../src/availability.ts';

const Z = 'America/Chicago';

const at = (iso: string): Date => new Date(iso);

const localFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: Z,
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});

// 'HH:MM' in the company zone for an instant.
function localHm(date: Date): string {
  const parts = localFormatter.formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

const localStarts = (slots: readonly Interval[]): string[] => slots.map((slot) => localHm(slot.start));

const busyItem = (startIso: string, endIso: string, propertyId: string | null): BusyItem => ({
  start: at(startIso),
  end: at(endIso),
  propertyId,
});

const MONDAY_FROM = '2026-10-12T05:00:00Z';
const MONDAY_TO = '2026-10-13T05:00:00Z';
const EARLY_NOW = '2026-10-01T00:00:00Z';

function query(overrides: Partial<SlotQuery> = {}): SlotQuery {
  return {
    workHours: DEFAULT_WORK_HOURS,
    busy: [],
    propertyId: null,
    durationMinutes: 60,
    bufferMinutes: 30,
    from: at(MONDAY_FROM),
    to: at(MONDAY_TO),
    timeZone: Z,
    minNoticeMinutes: 0,
    now: at(EARLY_NOW),
    ...overrides,
  };
}

describe('availability constants', () => {
  test('default durations per appointment kind', () => {
    expect(DEFAULT_DURATION_MINUTES).toEqual({ inspection: 60, adjuster: 60, other: 30 });
  });

  test('slot grid and horizon', () => {
    expect(SLOT_STEP_MINUTES).toBe(30);
    expect(MAX_AVAILABILITY_DAYS).toBe(14);
  });
});

describe('WorkHoursSchema', () => {
  test('the default company hours parse unchanged', () => {
    const result = WorkHoursSchema.safeParse(DEFAULT_WORK_HOURS);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({
      mon: [['08:00', '18:00']],
      tue: [['08:00', '18:00']],
      wed: [['08:00', '18:00']],
      thu: [['08:00', '18:00']],
      fri: [['08:00', '18:00']],
      sat: [['08:00', '12:00']],
      sun: [],
    });
  });

  test('DEFAULT_WORK_HOURS has Monday to Friday 08:00-18:00, Saturday 08:00-12:00, Sunday none', () => {
    expect(DEFAULT_WORK_HOURS.mon).toEqual([['08:00', '18:00']]);
    expect(DEFAULT_WORK_HOURS.fri).toEqual([['08:00', '18:00']]);
    expect(DEFAULT_WORK_HOURS.sat).toEqual([['08:00', '12:00']]);
    expect(DEFAULT_WORK_HOURS.sun).toEqual([]);
  });

  test('a 24:00 end is allowed', () => {
    const hours: WorkHours = { ...DEFAULT_WORK_HOURS, mon: [['08:00', '24:00']] };
    const result = WorkHoursSchema.safeParse(hours);
    expect(result.success).toBe(true);
  });

  test('overlapping ranges are refused and the message names the day', () => {
    const hours = { ...DEFAULT_WORK_HOURS, mon: [['08:00', '12:00'], ['11:00', '15:00']] };
    const result = WorkHoursSchema.safeParse(hours);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message.startsWith('mon')).toBe(true);
  });

  test('a 25:00 end is refused and the message names the day', () => {
    const hours = { ...DEFAULT_WORK_HOURS, tue: [['08:00', '25:00']] };
    const result = WorkHoursSchema.safeParse(hours);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message.startsWith('tue')).toBe(true);
  });

  test('four ranges in one day are refused and the message names the day', () => {
    const hours = {
      ...DEFAULT_WORK_HOURS,
      wed: [
        ['08:00', '09:00'],
        ['10:00', '11:00'],
        ['12:00', '13:00'],
        ['14:00', '15:00'],
      ],
    };
    const result = WorkHoursSchema.safeParse(hours);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message.startsWith('wed')).toBe(true);
  });
});

describe('findSlots', () => {
  test('a free Monday in Chicago gives 19 hourly-stepped 60-minute starts from 08:00 to 17:00', () => {
    const slots = findSlots(query());
    expect(slots).toHaveLength(19);
    expect(localHm(slots[0]!.start)).toBe('08:00');
    expect(localHm(slots[slots.length - 1]!.start)).toBe('17:00');
    for (const slot of slots) {
      expect(slot.end.getTime()).toBe(slot.start.getTime() + 60 * 60_000);
    }
  });

  test('slots are returned in time order on the half-hour grid', () => {
    const starts = findSlots(query()).map((slot) => slot.start.getTime());
    const sorted = [...starts].sort((a, b) => a - b);
    expect(starts).toEqual(sorted);
    expect(localStarts(findSlots(query())).slice(0, 3)).toEqual(['08:00', '08:30', '09:00']);
  });

  test('a busy item at another home blocks 09:00 to 11:00 starts with a 30-minute buffer', () => {
    const slots = findSlots(
      query({
        propertyId: 'a',
        busy: [busyItem('2026-10-12T15:00:00Z', '2026-10-12T16:00:00Z', 'b')],
      }),
    );
    const starts = localStarts(slots);
    for (const blocked of ['09:00', '09:30', '10:00', '10:30', '11:00']) {
      expect(starts).not.toContain(blocked);
    }
    expect(starts).toContain('08:30');
    expect(starts).toContain('11:30');
  });

  test('the same home needs no buffer: 09:00 and 11:00 are offered, 09:30 to 10:30 are not', () => {
    const slots = findSlots(
      query({
        propertyId: 'a',
        busy: [busyItem('2026-10-12T15:00:00Z', '2026-10-12T16:00:00Z', 'a')],
      }),
    );
    const starts = localStarts(slots);
    expect(starts).toContain('09:00');
    expect(starts).toContain('11:00');
    expect(starts).not.toContain('09:30');
    expect(starts).not.toContain('10:00');
    expect(starts).not.toContain('10:30');
  });

  test('a query with no property never counts as the same home, so the buffer applies', () => {
    const slots = findSlots(
      query({
        propertyId: null,
        busy: [busyItem('2026-10-12T15:00:00Z', '2026-10-12T16:00:00Z', null)],
      }),
    );
    const starts = localStarts(slots);
    expect(starts).not.toContain('09:00');
    expect(starts).not.toContain('11:00');
    expect(starts).toContain('08:30');
    expect(starts).toContain('11:30');
  });

  test('minimum notice of 120 minutes at 08:15 local starts the first slot at 10:30', () => {
    const slots = findSlots(query({ minNoticeMinutes: 120, now: at('2026-10-12T13:15:00Z') }));
    expect(localHm(slots[0]!.start)).toBe('10:30');
    expect(slots[0]!.start.getTime()).toBeGreaterThanOrEqual(at('2026-10-12T13:15:00Z').getTime() + 120 * 60_000);
  });

  test('an all-day busy item blocks the whole day', () => {
    const slots = findSlots(
      query({
        propertyId: 'a',
        busy: [busyItem(MONDAY_FROM, MONDAY_TO, 'b')],
      }),
    );
    expect(slots).toEqual([]);
  });

  test('Sunday has no slots with the default hours', () => {
    const slots = findSlots(
      query({
        from: at('2026-10-18T05:00:00Z'),
        to: at('2026-10-19T05:00:00Z'),
      }),
    );
    expect(slots).toEqual([]);
  });

  test('from and to clip the slots: 10:00 to 15:00 local gives starts 10:00 through 14:00', () => {
    const from = at('2026-10-12T15:00:00Z');
    const to = at('2026-10-12T20:00:00Z');
    const slots = findSlots(query({ from, to }));
    expect(localHm(slots[0]!.start)).toBe('10:00');
    expect(localHm(slots[slots.length - 1]!.start)).toBe('14:00');
    for (const slot of slots) {
      expect(slot.start.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(slot.end.getTime()).toBeLessThanOrEqual(to.getTime());
    }
  });

  test('a slot must fit inside one work interval, so none straddles lunch', () => {
    const hours: WorkHours = {
      ...DEFAULT_WORK_HOURS,
      mon: [
        ['08:00', '12:00'],
        ['13:00', '17:00'],
      ],
    };
    const slots = findSlots(query({ workHours: hours, durationMinutes: 120 }));
    expect(localStarts(slots)).toEqual([
      '08:00',
      '08:30',
      '09:00',
      '09:30',
      '10:00',
      '13:00',
      '13:30',
      '14:00',
      '14:30',
      '15:00',
    ]);
    const ends = slots.map((slot) => localHm(slot.end));
    expect(ends.filter((end) => end > '12:00' && end <= '13:00')).toEqual([]);
  });

  test('the 2026-03-08 spring-forward day gives its first slot at 13:00Z (CDT)', () => {
    const sundayHours: WorkHours = { ...DEFAULT_WORK_HOURS, sun: [['08:00', '18:00']] };
    const slots = findSlots(
      query({
        workHours: sundayHours,
        from: at('2026-03-08T06:00:00Z'),
        to: at('2026-03-09T05:00:00Z'),
        now: at('2026-03-01T00:00:00Z'),
      }),
    );
    expect(slots[0]!.start.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });
});

describe('workIntervals DST days', () => {
  const sundayHours: WorkHours = { ...DEFAULT_WORK_HOURS, sun: [['08:00', '18:00']] };

  test('2026-03-08 spring forward: Sunday 08:00-18:00 local is 13:00Z to 23:00Z (CDT)', () => {
    const intervals = workIntervals(sundayHours, at('2026-03-08T06:00:00Z'), at('2026-03-09T05:00:00Z'), Z);
    expect(intervals).toEqual([
      { start: at('2026-03-08T13:00:00.000Z'), end: at('2026-03-08T23:00:00.000Z') },
    ]);
  });

  test('2026-03-07 Saturday 08:00 local is 14:00Z (CST, before the change)', () => {
    const intervals = workIntervals(DEFAULT_WORK_HOURS, at('2026-03-07T06:00:00Z'), at('2026-03-08T06:00:00Z'), Z);
    expect(intervals[0]!.start.toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });

  test('2026-11-01 fall back: Sunday 08:00 local is 14:00Z (CST), ending at 2026-11-02T00:00:00Z', () => {
    const intervals = workIntervals(sundayHours, at('2026-11-01T05:00:00Z'), at('2026-11-02T06:00:00Z'), Z);
    expect(intervals).toEqual([
      { start: at('2026-11-01T14:00:00.000Z'), end: at('2026-11-02T00:00:00.000Z') },
    ]);
  });

  test('findSlots on 2026-11-01 starts the first Sunday slot at 14:00Z', () => {
    const slots = findSlots(
      query({
        workHours: sundayHours,
        from: at('2026-11-01T05:00:00Z'),
        to: at('2026-11-02T06:00:00Z'),
        now: at('2026-10-01T00:00:00Z'),
      }),
    );
    expect(slots[0]!.start.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });
});

describe('mergeIntervals', () => {
  test('overlapping intervals merge into one', () => {
    const merged = mergeIntervals([
      { start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T17:00:00Z') },
      { start: at('2026-10-12T16:00:00Z'), end: at('2026-10-12T18:00:00Z') },
    ]);
    expect(merged).toEqual([{ start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T18:00:00Z') }]);
  });

  test('touching intervals merge into one', () => {
    const merged = mergeIntervals([
      { start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T16:00:00Z') },
      { start: at('2026-10-12T16:00:00Z'), end: at('2026-10-12T17:00:00Z') },
    ]);
    expect(merged).toEqual([{ start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T17:00:00Z') }]);
  });

  test('unsorted input comes back sorted and disjoint intervals stay apart', () => {
    const merged = mergeIntervals([
      { start: at('2026-10-12T20:00:00Z'), end: at('2026-10-12T21:00:00Z') },
      { start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T16:00:00Z') },
    ]);
    expect(merged).toEqual([
      { start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T16:00:00Z') },
      { start: at('2026-10-12T20:00:00Z'), end: at('2026-10-12T21:00:00Z') },
    ]);
  });

  test('empty input gives an empty list', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  test('the input is not mutated', () => {
    const input: Interval[] = [
      { start: at('2026-10-12T20:00:00Z'), end: at('2026-10-12T21:00:00Z') },
      { start: at('2026-10-12T15:00:00Z'), end: at('2026-10-12T16:00:00Z') },
      { start: at('2026-10-12T15:30:00Z'), end: at('2026-10-12T17:00:00Z') },
    ];
    const before = input.map((interval) => ({
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
    }));
    const firstStartRef = input[0]!.start;
    mergeIntervals(input);
    expect(input.map((interval) => ({ start: interval.start.toISOString(), end: interval.end.toISOString() }))).toEqual(
      before,
    );
    expect(input[0]!.start).toBe(firstStartRef);
    expect(input).toHaveLength(3);
  });
});
