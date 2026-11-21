import { describe, expect, it } from 'vitest';
import { reconstructRoof, type LocalRoof } from '../src/roof-reconstruct/index.ts';
import { type Shape, synthesize } from './fixtures/synthetic-roofs.ts';

// Creases labelled by which way each face drains (topology.ts): an upper face draining onto a lower one ends there
// in an eave (as a report counts it), not a valley; two faces falling away on opposite sides meet in a ridge even
// when it climbs a little; a true valley still is one.

function lengths(roof: LocalRoof): Record<string, number> {
  const by: Record<string, number> = {};
  for (const l of roof.lines) by[l.kind] = (by[l.kind] ?? 0) + l.lengthM;
  return by;
}

/**
 * A gable 10 x 8 m at `main`/12 (ridge along X, eaves 3 m up) whose south face runs on, with no step, into a porch roof
 * 10 x 3 m at `porch`/12 falling the same way.
 */
function runOnPorch(main: number, porch: number): Shape {
  return {
    name: `run-on porch ${main}/${porch}`,
    extent: 10,
    height: ({ x, y }) => {
      if (Math.abs(x) > 5 || y > 4 || y < -7) return null;
      if (y >= -4) return 3 + (4 - Math.abs(y)) * (main / 12);
      return 3 - (-4 - y) * (porch / 12);
    },
    faces: [
      { name: 'north', probe: { x: 0, y: 2 }, pitchX12: main, downDeg: 90, planAreaM2: 40 },
      { name: 'south', probe: { x: 0, y: -2 }, pitchX12: main, downDeg: -90, planAreaM2: 40 },
      { name: 'porch', probe: { x: 0, y: -5.5 }, pitchX12: porch, downDeg: -90, planAreaM2: 30 },
    ],
    lines: { ridge: 10, eave: 30 },
    planAreaM2: 110,
  };
}

/** A gable 10 m long at 12/12 whose south face is turned `skewDeg` from opposite the north face: its ridge climbs. */
function skewGable(skewDeg: number): Shape {
  const t = (skewDeg * Math.PI) / 180;
  const north = ({ y }: { x: number; y: number }) => 7 - y;
  const south = ({ x, y }: { x: number; y: number }) => 7 + (x * Math.sin(t) + y * Math.cos(t));
  return {
    name: `skew gable ${skewDeg}`,
    extent: 9,
    height: (p) => (Math.abs(p.x) > 5 || Math.abs(p.y) > 4 ? null : Math.min(north(p), south(p))),
    faces: [
      { name: 'north', probe: { x: 0, y: 2.5 }, pitchX12: 12, downDeg: 90, planAreaM2: 40 },
      { name: 'south', probe: { x: 0, y: -2.5 }, pitchX12: 12, downDeg: -90 + skewDeg, planAreaM2: 40 },
    ],
    lines: { ridge: 10 },
    planAreaM2: 80,
  };
}

describe('creases by drainage', () => {
  it('a main roof running on into a much flatter porch roof ends there in an eave, not a valley', () => {
    for (const turnDeg of [0, 23]) {
      const syn = synthesize(runOnPorch(8, 3), { turnDeg, seed: 11, trees: 0 });
      const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
      expect(r).not.toBeNull();
      const by = lengths(r!);
      expect(by.valley ?? 0, `valley at ${turnDeg}`).toBeLessThan(1);
      expect(by.hip ?? 0, `hip at ${turnDeg}`).toBeLessThan(1);
      // North eave, porch eave, and the main roof's eave over the porch: 30 m.
      expect(by.eave ?? 0, `eave at ${turnDeg}`).toBeGreaterThan(27);
      expect(by.eave ?? 0, `eave at ${turnDeg}`).toBeLessThan(33);
    }
  });

  it('faces sloping the same way at nearly the same pitch are one slope: no eave between them', () => {
    for (const porch of [6.2, 6.8]) {
      const syn = synthesize(runOnPorch(8, porch), { turnDeg: 17, seed: 11, trees: 0 });
      const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
      expect(r).not.toBeNull();
      const by = lengths(r!);
      // North and porch eaves only: 20 m. (The two south faces are merged, or meet in a pitch break; where two planes
      // this alike meet is not well determined, and a line that comes out climbing is left to the planes.)
      expect(by.eave ?? 0, `eave, porch ${porch}`).toBeGreaterThan(18);
      expect(by.eave ?? 0, `eave, porch ${porch}`).toBeLessThan(22);
    }
  });

  it('two faces falling away on opposite sides meet in a ridge even when the crease climbs', () => {
    const syn = synthesize(skewGable(20), { turnDeg: 0, seed: 11, trees: 0 });
    const r = reconstructRoof(syn.raster, syn.point, { seed: 7 });
    expect(r).not.toBeNull();
    const by = lengths(r!);
    expect(by.hip ?? 0).toBeLessThan(1);
    expect(by.ridge ?? 0).toBeGreaterThan(8);
    // The same roof under the old rule (level creases only) is a hip: the test would not see the change otherwise.
    const old = reconstructRoof(syn.raster, syn.point, { seed: 7, topology: { ridgeFacingDeg: 181 } });
    expect(lengths(old!).hip ?? 0).toBeGreaterThan(8);
  });
});
