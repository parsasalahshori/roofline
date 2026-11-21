import { describe, expect, it } from 'vitest';
import { reconstructRoof, type LocalRoof } from '../src/roof-reconstruct/index.ts';
import { flipShortRuns } from '../src/roof-reconstruct/topology.ts';
import { type Shape, synthesize } from './fixtures/synthetic-roofs.ts';

// A boundary between two faces typed piece by piece (topology.ts, stepPieceM): where one face ends above the other
// for a stretch (a dormer's front and cheek walls) the upper face has its rake or eave there and the lower face its
// flashing, and the rest of the same boundary (the valley behind the cheek wall) stays a crease.

function lengths(roof: LocalRoof): Record<string, number> {
  const by: Record<string, number> = {};
  for (const l of roof.lines) by[l.kind] = (by[l.kind] ?? 0) + l.lengthM;
  return by;
}

const P = 8 / 12;

/**
 * A gable 16 x 12 m at 8/12 (ridge along X, eaves 3 m up) with a gable dormer 4 m wide at 8/12 on its south face. The
 * dormer's ridge runs along Y; its eaves stand 2 m above the main eave and its front wall 1 m in from it, so the main
 * roof runs on in front of it. Each cheek wall is 1.33 m tall at the front and tapers to nothing 2 m back, where the
 * valley to the dormer's ridge starts.
 */
const TALL_DORMER: Shape = {
  name: 'gable with a tall dormer',
  extent: 12,
  height: ({ x, y }) => {
    if (Math.abs(x) > 8 || Math.abs(y) > 6) return null;
    const main = 3 + (6 - Math.abs(y)) * P;
    const dormer = y >= -5 && y < 0 && Math.abs(x) <= 2 ? 5 + (2 - Math.abs(x)) * P : -Infinity;
    return Math.max(main, dormer);
  },
  faces: [
    { name: 'north', probe: { x: 0, y: 3 }, pitchX12: 8, downDeg: 90, planAreaM2: 96 },
    { name: 'south', probe: { x: 5.5, y: -3 }, pitchX12: 8, downDeg: -90, planAreaM2: 84 },
    { name: 'dormer east', probe: { x: 1, y: -3.5 }, pitchX12: 8, downDeg: 0, planAreaM2: 6 },
    { name: 'dormer west', probe: { x: -1, y: -3.5 }, pitchX12: 8, downDeg: 180, planAreaM2: 6 },
  ],
  lines: {
    // Main ridge, and the dormer's from its front (Y -5) to the main roof (Y -1).
    ridge: 16 + 4,
    // From each cheek wall's end (2, -3) to the dormer ridge's end (0, -1), climbing 1.33 m.
    valley: 2 * Math.hypot(2, 2, 2 * P),
    // Both main eaves, and the dormer's two over its cheek walls.
    eave: 32 + 2 * 2,
    // The main gable's four, and the dormer front's two.
    rake: 4 * Math.hypot(6, 6 * P) + 2 * Math.hypot(2, 2 * P),
    // The main roof against the dormer's front wall (level) and its cheek walls (up the slope).
    flashing: 4,
    'step-flashing': 2 * Math.hypot(2, 2 * P),
  },
  planAreaM2: 192,
};

/**
 * A gable 12 x 8 m at 8/12 whose south face stands `stepM` higher than its north face at the ridge: two faces falling
 * away from the line between them, the height map holding them apart.
 */
function offsetRidge(stepM: number): Shape {
  return {
    name: `ridge with a ${stepM} m step`,
    extent: 9,
    height: ({ x, y }) => {
      if (Math.abs(x) > 6 || Math.abs(y) > 4) return null;
      return 3 + (4 - Math.abs(y)) * P + (y < 0 ? stepM : 0);
    },
    faces: [
      { name: 'north', probe: { x: 0, y: 2 }, pitchX12: 8, downDeg: 90, planAreaM2: 48 },
      { name: 'south', probe: { x: 0, y: -2 }, pitchX12: 8, downDeg: -90, planAreaM2: 48 },
    ],
    lines: { ridge: 12 },
    planAreaM2: 96,
  };
}

describe('walls for a stretch of a boundary', () => {
  it("a dormer's front and cheek walls are its rakes and eaves over the main roof's flashing; the valleys behind them stay", () => {
    const truth = TALL_DORMER.lines;
    for (const turnDeg of [0, 17]) {
      const syn = synthesize(TALL_DORMER, { turnDeg, seed: 11, trees: 0 });
      const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
      expect(r).not.toBeNull();
      expect(r!.faces.length, `faces at ${turnDeg}`).toBe(4);
      const by = lengths(r!);
      const at = `at ${turnDeg}: ${JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`;
      expect(by.hip ?? 0, `hip ${at}`).toBeLessThan(1);
      expect(Math.abs((by.valley ?? 0) - truth.valley!), `valley ${at}`).toBeLessThan(1.5);
      expect(Math.abs((by.eave ?? 0) - truth.eave!), `eave ${at}`).toBeLessThan(2);
      expect(Math.abs((by.rake ?? 0) - truth.rake!), `rake ${at}`).toBeLessThan(2);
      expect(Math.abs((by.flashing ?? 0) - truth.flashing!), `flashing ${at}`).toBeLessThan(1.5);
      expect(Math.abs((by['step-flashing'] ?? 0) - truth['step-flashing']!), `step flashing ${at}`).toBeLessThan(1.5);
      expect(Math.abs((by.ridge ?? 0) - truth.ridge!), `ridge ${at}`).toBeLessThan(1.5);

      // Typed once for its whole length, the same boundary is a crease all the way: the dormer's front comes out a
      // hip and its eaves valleys (the test would not see the change otherwise).
      const whole = lengths(reconstructRoof(syn.raster, syn.point, { seed: 7, topology: { stepPieceM: 0 } })!);
      expect((whole.hip ?? 0) + (whole.valley ?? 0), `whole-length typing at ${turnDeg}`).toBeGreaterThan(truth.valley! + 5);
      expect((whole.flashing ?? 0) + (whole['step-flashing'] ?? 0), `whole-length typing at ${turnDeg}`).toBeLessThan(2);
    }
  }, 30_000);

  it("the wall runs on to where the planes meet: the cheek wall's low end is still the dormer's eave", () => {
    const syn = synthesize(TALL_DORMER, { turnDeg: 17, seed: 11, trees: 0 });
    const eaveOf = (stepTaperM: number) => lengths(reconstructRoof(syn.raster, syn.point, { seed: 7, topology: { stepTaperM } })!).eave ?? 0;
    // The height map shows no jump over the last, low metre of each cheek wall (the fixture's blur): without the
    // run-on the dormer's eaves stop short there.
    expect(eaveOf(3)).toBeGreaterThan(eaveOf(0) + 1);
  }, 30_000);

  it('a small step at the top of a face, both faces falling away from it, is their ridge; a tall one is a wall', () => {
    const low = synthesize(offsetRidge(1), { turnDeg: 17, seed: 11, trees: 0 });
    const by = lengths(reconstructRoof(low.raster, low.point, { seed: 7 })!);
    expect(by.ridge ?? 0).toBeGreaterThan(10);
    expect(by.flashing ?? 0).toBeLessThan(1);
    expect(by.eave ?? 0).toBeLessThan(26);
    // Without the rule the step is a wall: the upper face's "eave" over the lower face's flashing, and no ridge.
    const old = lengths(reconstructRoof(low.raster, low.point, { seed: 7, topology: { stepTopM: 0 } })!);
    expect(old.flashing ?? 0).toBeGreaterThan(10);
    expect(old.ridge ?? 0).toBeLessThan(2);

    const tall = synthesize(offsetRidge(2), { turnDeg: 17, seed: 11, trees: 0 });
    const high = lengths(reconstructRoof(tall.raster, tall.point, { seed: 7 })!);
    expect(high.flashing ?? 0).toBeGreaterThan(10);
  }, 30_000);
});

describe('flipShortRuns', () => {
  const run = (bits: string, value: boolean, minLen: number, cyclic: boolean, insideOnly: boolean) =>
    flipShortRuns([...bits].map((c) => c === '1'), value, minLen, cyclic, insideOnly).map((b) => (b ? '1' : '0')).join('');

  it('flips runs shorter than the minimum, and only those', () => {
    expect(run('0011000111000', true, 3, false, false)).toBe('0000000111000');
    expect(run('1110011100011', false, 3, false, false)).toBe('1111111100011');
  });

  it('leaves a run at either end of an open sequence alone when asked to', () => {
    expect(run('00111001110', false, 3, false, true)).toBe('00111111110');
    expect(run('00111001110', false, 3, false, false)).toBe('11111111111');
  });

  it('joins a run across the end of a ring', () => {
    // The two ones at the start and the one at the end are one run of three on a ring.
    expect(run('1100000001', true, 3, true, false)).toBe('1100000001');
    expect(run('1100000001', true, 4, true, false)).toBe('0000000000');
    expect(run('1100000001', true, 3, false, false)).toBe('0000000000');
  });

  it('leaves a sequence of one value as it is', () => {
    expect(run('1111', true, 9, true, false)).toBe('1111');
    expect(run('', true, 3, false, false)).toBe('');
  });
});
