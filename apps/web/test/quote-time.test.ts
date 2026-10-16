import { describe, expect, it } from 'vitest';
import { visitTime } from '../src/features/quote/time.ts';

describe('visitTime', () => {
  const start = '2026-10-16T16:00:00.000Z'; // 11:00 AM in Chicago, 9:00 AM in Los Angeles

  it("shows the company's local time, with its zone name when the viewer is elsewhere", () => {
    expect(visitTime(start, 'America/Chicago', 'short', 'America/Los_Angeles')).toBe('Fri, Oct 16, 11:00 AM CDT');
    expect(visitTime(start, 'America/Chicago', 'long', 'America/Los_Angeles')).toBe('Friday, October 16 at 11:00 AM CDT');
  });

  it('leaves the zone name off when the viewer is in the same zone', () => {
    expect(visitTime(start, 'America/Chicago', 'short', 'America/Chicago')).toBe('Fri, Oct 16, 11:00 AM');
  });
});
