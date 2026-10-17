import { hoursLabel } from '@roofline/shared';
import { describe, expect, it } from 'vitest';
import { hoursParts } from '../src/features/agents/agentTheme.ts';

const words = (minutes: number): string => {
  const parts = hoursParts(minutes);
  return `${parts.lead} ${parts.number} ${parts.unit}`;
};

describe('hoursParts', () => {
  it.each([15, 29, 30, 44, 45, 60, 89, 270, 599, 600, 1860, 6600, 60000])('reads %i minutes the way hoursLabel does', (minutes) => {
    expect(words(minutes)).toBe(hoursLabel(minutes));
  });

  it('says "less than 0.5 hours" under a quarter of an hour, and never a negative or a broken number', () => {
    for (const minutes of [0, 5, 14.9, -30, Number.NaN, Number.POSITIVE_INFINITY * 0]) {
      expect(words(minutes)).toBe('less than 0.5 hours');
    }
  });

  it('has one hour in the singular', () => {
    expect(hoursParts(60).unit).toBe('hour');
    expect(hoursParts(90).unit).toBe('hours');
  });
});
