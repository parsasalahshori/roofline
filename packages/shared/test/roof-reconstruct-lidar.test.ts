// The lidar hidden-edge step (roof-reconstruct/outline-lidar.ts) on synthetic scenes with exact truth: a gable whose
// end is hidden under a crown (Google's mask stops at the crown, its heights there are the canopy), and a leaf-off
// lidar cloud of the true roof and ground seen between bare branches, in its own frame (shifted horizontally, another
// vertical datum). Hermetic: no files, no network, seeded randomness only. 0.1 m and 0.25 m (Google MEDIUM) grids.
import { describe, expect, it } from 'vitest';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { offsetEdges } from '../src/roof-reconstruct/outline-lidar.ts';
import { type Scene, scene, type XY } from './fixtures/lidar-scene.ts';
import { signedArea } from '../src/roof-reconstruct/geom.ts';

const planArea = (ring: readonly XY[]) => Math.abs(signedArea(ring));

/** The outline's extent along the house's x axis (max over its corners). */
const maxHouseX = (sc: Scene, ring: readonly XY[]) => Math.max(...ring.map((p) => sc.toHouse(p).x));
const maxHouseY = (sc: Scene, ring: readonly XY[]) => Math.max(...ring.map((p) => sc.toHouse(p).y));

describe('lidar hidden edges', () => {
  for (const pixelM of [0.1, 0.25]) {
    for (const turnDeg of [0, 17, 40]) {
      it(`moves the rake hidden under a crown onto the lidar's eave (${pixelM} m pixels, turned ${turnDeg} deg)`, () => {
        const sc = scene({ seed: 3 + turnDeg, turnDeg, pixelM });
        const off = reconstructRoof(sc.raster, sc.point);
        const on = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: sc.cloud() } });
        expect(off).not.toBeNull();
        expect(on).not.toBeNull();
        // Google's outline stops at the crown, 2 m short.
        expect(maxHouseX(sc, off!.outline)).toBeLessThan(6 - 1.5);
        expect(on!.lidarEdges?.applied).toBe(true);
        // The lidar's: within 0.3 m of the true end (0.4 m at 0.25 m pixels), area within 5 %.
        expect(Math.abs(maxHouseX(sc, on!.outline) - 6)).toBeLessThan(pixelM > 0.2 ? 0.4 : 0.3);
        expect(Math.abs(planArea(on!.outline) - sc.areaM2) / sc.areaM2).toBeLessThan(0.05);
        // Registration found the frame offset it was given.
        expect(on!.lidarEdges!.shift!.dx).toBeCloseTo(0.7, 0);
        expect(on!.lidarEdges!.shift!.dz).toBeCloseTo(31.2, 0);
      });
    }
  }

  it('moves an eave hidden under a crown (the long side), at 0.1 m', () => {
    const sc = scene({ seed: 21, turnDeg: 12, side: 'eave', hideM: 1.5 });
    const off = reconstructRoof(sc.raster, sc.point)!;
    const on = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: sc.cloud() } })!;
    expect(maxHouseY(sc, off.outline)).toBeLessThan(4 - 1);
    expect(on.lidarEdges?.applied).toBe(true);
    expect(Math.abs(maxHouseY(sc, on.outline) - 4)).toBeLessThan(0.3);
  });

  it('is byte-identical on a rerun, and the option off is the reconstruction as before', () => {
    const sc = scene({ seed: 5, turnDeg: 17 });
    const cloud = sc.cloud();
    const a = JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidar: { cloud } }));
    const b = JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidar: { cloud } }));
    expect(a).toBe(b);
    const off1 = JSON.stringify(reconstructRoof(sc.raster, sc.point));
    const off2 = JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidar: null }));
    expect(off1).toBe(off2);
  });

  it('declines with a typed reason and leaves the outline alone', () => {
    const sc = scene({ seed: 8, turnDeg: 17 });
    const off = reconstructRoof(sc.raster, sc.point)!;
    const cases: [Parameters<Scene['cloud']>[0], string][] = [
      [{ leafOff: false }, 'not-leaf-off'],
      [{ leafOff: null }, 'not-leaf-off'],
      [{ density: 1.5 }, 'sparse'],
    ];
    for (const [o, reason] of cases) {
      const on = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: sc.cloud(o) } })!;
      expect(on.lidarEdges).toMatchObject({ applied: false, reason });
      expect(on.outline).toEqual(off.outline);
    }
    // Lidar of another place (no roof where Google has one): the frame cannot be registered.
    const other = scene({ seed: 9, turnDeg: 70, hx: 3, hy: 2 });
    const wrong = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: other.cloud({ shift: { x: 9, y: 9 } }) } })!;
    expect(wrong.lidarEdges?.applied).toBe(false);
    expect(wrong.outline).toEqual(off.outline);
    // An empty or malformed cloud.
    const empty = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: { x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0), flags: new Uint8Array(0), leafOff: true } } })!;
    expect(empty.lidarEdges).toMatchObject({ applied: false, reason: 'no-points' });
  });

  it('with no crown, has no hidden edge to move', () => {
    const sc = scene({ seed: 4, turnDeg: 25, hideM: -10 });
    const on = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: sc.cloud() } })!;
    expect(on.lidarEdges?.applied).toBe(false);
    expect(on.lidarEdges?.reason).toBe('no-hidden-edges');
  });

  it('a house changed since the flight is not trusted', () => {
    const sc = scene({ seed: 6, turnDeg: 10 });
    const off = reconstructRoof(sc.raster, sc.point)!;
    // The lidar saw it 1 m wider on both long sides (rebuilt, so a higher ridge too): its roof is not on Google's planes
    // ('misaligned') or its visible edges disagree in a way no shift explains ('changed').
    const wider = scene({ seed: 6, turnDeg: 10, hy: 5 });
    const on = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: wider.cloud() } })!;
    expect(on.lidarEdges?.applied).toBe(false);
    expect(['changed', 'misaligned']).toContain(on.lidarEdges?.reason);
    expect(on.outline).toEqual(off.outline);
    // 2 m shorter (1 m at each end): the visible west end alone reads as a 1 m shift along the house, which the edge
    // frame takes out, so the hidden east end is not moved either. Ambiguous, and safe: nothing changes.
    const shorter = scene({ seed: 6, turnDeg: 10, hx: 5 });
    const on2 = reconstructRoof(sc.raster, sc.point, { lidar: { cloud: shorter.cloud() } })!;
    expect(on2.lidarEdges?.applied).toBe(false);
    expect(on2.outline).toEqual(off.outline);
  });
});

describe('offsetEdges', () => {
  const sq = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 6 },
    { x: 0, y: 6 },
  ];
  it('moves one edge parallel and rebuilds its corners', () => {
    // Counter-clockwise; edge 1 (x = 10) moved 2 m out.
    const out = offsetEdges(sq, [0, 2, 0, 0], true)!;
    expect(out).toEqual([
      { x: 0, y: 0 },
      { x: 12, y: 0 },
      { x: 12, y: 6 },
      { x: 0, y: 6 },
    ]);
    expect(planArea(out)).toBeCloseTo(72, 6);
  });
  it('puts a jog between collinear neighbours', () => {
    const ring = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 6 },
      { x: 0, y: 6 },
    ];
    // Edge 1 (5..10 along y = 0) moved 1 m out (south, y = -1).
    const out = offsetEdges(ring, [0, 1, 0, 0, 0], true)!;
    expect(out).toContainEqual({ x: 5, y: -1 });
    expect(out).toContainEqual({ x: 5, y: 0 });
    expect(planArea(out)).toBeCloseTo(65, 6);
  });
});
