import { describe, expect, it } from 'vitest';
import { measure } from '../src/copy/measure.ts';
import { measureGutters } from '../src/copy/measureGutters.ts';
import { measureWindows } from '../src/copy/measureWindows.ts';

describe('the measure screens’ words', () => {
  it('writes the hail size with its unit and no full stop after it, like every other size in the app', () => {
    expect(measure.hailSize(0.75)).toBe('0.75 in hail on record');
    expect(measure.hailSize(1.5)).toBe('1.5 in hail on record');
  });

  it('says what the owner can do while sending a window or gutter proposal is off, not what comes next', () => {
    for (const note of [measureWindows.sendNext, measureGutters.sendNext]) {
      expect(note).toMatch(/cannot be sent from here yet/);
      expect(note).toMatch(/yourself\.$/);
      expect(note).not.toMatch(/comes? next/i);
    }
  });

  it('asks to measure by hand once in a window’s notes, not once per reason', () => {
    const notes = [measureWindows.table.reasonUnclear, measureWindows.table.reasonDoubt('3/4')];
    expect(notes.filter((note) => /by hand/.test(note))).toHaveLength(1);
  });

  it('names the first grade shorter for a phone’s narrow tile', () => {
    expect(measureWindows.ladder.estimatePhone).toBe('Estimate');
    expect(measureWindows.ladder.estimatePhone.length).toBeLessThan(measureWindows.ladder.estimate.length);
  });
});
