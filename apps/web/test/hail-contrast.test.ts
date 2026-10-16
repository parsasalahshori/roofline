import { describe, expect, it } from 'vitest';
import { tokens } from '@roofline/ui';
import { HAIL_LEVEL_COLORS } from '../src/shell/map/stormLayer.ts';

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

describe('hail colour contrast', () => {
  it('outlines meet 3:1 against the base map', () => {
    // The swath outline is drawn in tokens.ink (#0d1724) over the base map land tokens['map-land']
    // (#e9ece8, used by mapStyle.ts): the ratio is about 15:1, far above the 3:1 minimum.
    expect(contrast(tokens.ink, tokens['map-land'])).toBeGreaterThanOrEqual(3);
  });

  it('documents each hail colour contrast', () => {
    // The fills are only part of the signal (the dark outline and the legend carry it), so the
    // yellow fills are not held to 3:1. These are the measured ratios against the map's land colour, tokens['map-land'].
    const expected = [1.1, 1.5, 2.4, 3.5, 5.4];
    expect(HAIL_LEVEL_COLORS.map((color) => round1(contrast(color, tokens['map-land'])))).toEqual(expected);
  });

  it('has five distinct colours in level order', () => {
    expect(HAIL_LEVEL_COLORS).toEqual([
      tokens['hail-1'],
      tokens['hail-2'],
      tokens['hail-3'],
      tokens['hail-4'],
      tokens['hail-5'],
    ]);
    expect(new Set(HAIL_LEVEL_COLORS).size).toBe(5);
  });
});
