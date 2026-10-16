import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildArSizingFixtures, FIXTURE_PATH, fixtureJson } from '../ios-ar-fixtures.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('the iPhone AR sizing fixtures', () => {
  const { cases } = buildArSizingFixtures();

  it('the committed file matches the TypeScript math (run npm run ios:fixtures after changing it)', () => {
    expect(readFileSync(path.join(ROOT, FIXTURE_PATH), 'utf8')).toBe(fixtureJson());
  });

  it('has the basic, tilted, spread, check and degenerate cases, and all 24 tap orders', () => {
    const groups = new Set(cases.map((c) => c.group));
    for (const g of ['basic', 'turned', 'tilted', 'sizes', 'spread', 'noise', 'check', 'degenerate', 'tap-orders']) expect(groups).toContain(g);
    expect(cases.filter((c) => c.group === 'tap-orders')).toHaveLength(24);
    expect(cases.filter((c) => c.group !== 'tap-orders').length).toBeGreaterThanOrEqual(20);
  });

  it('every tap order gives the same size, ± and quality', () => {
    const taps = cases.filter((c) => c.group === 'tap-orders').map((c) => c.expected!);
    for (const e of taps) {
      expect(e.widthIn).toBeCloseTo(taps[0]!.widthIn, 9);
      expect(e.heightIn).toBeCloseTo(taps[0]!.heightIn, 9);
      expect(e.uncertaintyIn.width).toBeCloseTo(taps[0]!.uncertaintyIn.width, 9);
      expect(e.uncertaintyIn.height).toBeCloseTo(taps[0]!.uncertaintyIn.height, 9);
      expect(e.quality).toBe(taps[0]!.quality);
    }
  });

  it('exact frames come out at their size; the check shapes are check; four taps on one spot are refused', () => {
    const byName = (start: string) => cases.find((c) => c.name.startsWith(start))!.expected;
    expect(byName('36 x 60 straight on, 2 m')).toMatchObject({ quality: 'good' });
    expect(byName('36 x 60 straight on, 2 m')!.widthIn).toBeCloseTo(36, 9);
    expect(byName('tilted wall: 30 x 30')!.heightIn).toBeCloseTo(30, 9);
    for (const c of cases.filter((x) => x.group === 'check')) expect(c.expected!.quality).toBe('check');
    expect(byName('four taps on one spot')).toBeNull();
  });
});
