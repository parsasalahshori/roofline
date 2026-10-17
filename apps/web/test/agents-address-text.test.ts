import { describe, expect, it } from 'vitest';
import { keepAddressTogether } from '../src/features/agents/addressText.ts';

const NBSP = ' ';

describe('keepAddressTogether', () => {
  it('joins a house number to its street name', () => {
    expect(keepAddressTogether('Booked an inspection at 305 Ridgeway Dr')).toBe(`Booked an inspection at 305${NBSP}Ridgeway Dr`);
    expect(keepAddressTogether('Scored 2406 Harney St in last night’s hail path')).toBe(`Scored 2406${NBSP}Harney St in last night’s hail path`);
  });

  it('joins a number, a direction and the street when there is one', () => {
    expect(keepAddressTogether('Storm Scout drafted a text near 5411 W 12th St')).toBe(`Storm Scout drafted a text near 5411${NBSP}W${NBSP}12th St`);
  });

  it('leaves a count of things alone', () => {
    const counts = 'Texted 13 customers, 2 leads and 636 roofs';
    expect(keepAddressTogether(counts)).toBe(counts);
    expect(keepAddressTogether('Sent 13 texts')).toBe('Sent 13 texts');
    expect(keepAddressTogether('Up to 1.5" hail')).toBe('Up to 1.5" hail');
  });

  it('keeps text without numbers as it was', () => {
    expect(keepAddressTogether('Nothing yet today')).toBe('Nothing yet today');
  });
});
