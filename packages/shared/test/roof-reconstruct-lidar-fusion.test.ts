// Lidar fusion (roof-reconstruct/lidar-fusion.ts) on synthetic scenes with exact truth (fixtures/lidar-scene.ts): a
// gable whose east part is hidden under a leaf-on crown (Google's mask stops at the crown, its heights there are the
// canopy), and a leaf-off lidar cloud of the true roof in another frame. Hermetic: seeded randomness only, no files.
import { describe, expect, it } from 'vitest';
import { reconstructRoof, toRoof3d } from '../src/roof-reconstruct/index.ts';
import { DEFAULT_LIDAR_FUSION, fuseLidar } from '../src/roof-reconstruct/lidar-fusion.ts';
import { signedArea } from '../src/roof-reconstruct/geom.ts';
import { type Scene, scene, type XY } from './fixtures/lidar-scene.ts';

const planArea = (ring: readonly XY[]) => Math.abs(signedArea(ring));
const maxHouseX = (sc: Scene, ring: readonly XY[]) => Math.max(...ring.map((p) => sc.toHouse(p).x));

describe('lidar fusion', () => {
  for (const pixelM of [0.1, 0.25]) {
    for (const turnDeg of [0, 23]) {
      it(`adds the part of the roof hidden under a crown, with the lidar's pitch (${pixelM} m pixels, turned ${turnDeg} deg)`, () => {
        // 5 m of a 12 m gable under the crown: about 40 m2 of roof Google's heights do not show.
        const sc = scene({ seed: 31 + turnDeg, turnDeg, pixelM, hideM: 5 });
        const off = reconstructRoof(sc.raster, sc.point)!;
        const on = reconstructRoof(sc.raster, sc.point, { lidarFusion: { cloud: sc.cloud() } })!;
        expect(maxHouseX(sc, off.outline)).toBeLessThan(6 - 4);
        expect(on.lidarFusion?.applied).toBe(true);
        // The roof's true east end (x = 6) within half a metre, and the area within 6 % of the truth (12 % on MEDIUM
        // 0.25 m pixels, where the squared outline loses a jog at the seam); off: about 40 % short.
        expect(Math.abs(maxHouseX(sc, on.outline) - 6)).toBeLessThan(0.5);
        expect(Math.abs(planArea(on.outline) - sc.areaM2) / sc.areaM2).toBeLessThan(pixelM > 0.2 ? 0.12 : 0.08);
        expect(planArea(off.outline) / sc.areaM2).toBeLessThan(0.65);
        // Provenance: the gable's two faces run on under the crown, so each carries the share of it the lidar alone saw
        // (about 40 %), and their pitch stays the true 6/12.
        const lidarFaces = on.faces.filter((f) => (f.lidarShare ?? 0) > 0.2);
        expect(lidarFaces.length).toBeGreaterThan(0);
        for (const f of lidarFaces) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.5);
        expect(on.lidarFusion!.addedShare).toBeGreaterThan(0.25);
        expect(on.quality.reasons).toContain('roof-from-lidar');
        // Google's own faces keep Google's pitch.
        for (const f of on.faces.filter((x) => x.source === undefined)) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.5);
        // Registration found the frame offset it was given.
        expect(on.lidarFusion!.shift!.dx).toBeCloseTo(0.7, 0);
        expect(on.lidarFusion!.shift!.dz).toBeCloseTo(31.2, 0);
        // The stored roof carries it: source on the faces, the summary, the reason.
        const r3 = toRoof3d(on, (x, y) => [x / 1e5, y / 1e5], { imageryQuality: 'HIGH', imageryDate: null });
        expect(r3.lidarFusion?.applied).toBe(true);
        expect(r3.lidarFusion!.parts.length).toBeGreaterThanOrEqual(lidarFaces.length);
        expect(r3.faces.filter((f) => (f.lidarShare ?? 0) > 0.2).length).toBe(lidarFaces.length);
        expect(r3.quality?.reasons).toContain('roof-from-lidar');
      });
    }
  }

  it("gives the edge evidence the lidar's ground under the crown beside the added roof, never the reconstruction", () => {
    const sc = scene({ seed: 33, turnDeg: 0, hideM: 5 });
    const f = fuseLidar(sc.raster, sc.point, sc.cloud());
    expect(f.report.applied).toBe(true);
    const ev = f.evidence!;
    let n = 0;
    let worst = 0;
    for (let i = 0; i < ev.groundPx.length; i++) {
      if (ev.groundPx[i] !== 1) continue;
      n++;
      // Ground is at 0 in the scene's frame; the canopy there is 6-9 m.
      worst = Math.max(worst, Math.abs(ev.dsm[i]!));
      expect(f.raster.dsm[i]).toBe(sc.raster.dsm[i]);
      expect(f.raster.mask[i]).toBe(sc.raster.mask[i]);
    }
    expect(n * 0.01).toBeGreaterThan(5);
    expect(worst).toBeLessThan(0.3);
  });

  it('is byte-identical on a rerun, and the option off (or null) is the reconstruction as before', () => {
    const sc = scene({ seed: 41, turnDeg: 17, hideM: 5 });
    const cloud = sc.cloud();
    const a = JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidarFusion: { cloud } }));
    const b = JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidarFusion: { cloud } }));
    expect(a).toBe(b);
    expect(JSON.stringify(reconstructRoof(sc.raster, sc.point))).toBe(JSON.stringify(reconstructRoof(sc.raster, sc.point, { lidarFusion: null })));
  });

  it('with nothing hidden adds nothing, and the roof is the one without lidar', () => {
    const sc = scene({ seed: 44, turnDeg: 25, hideM: -10 });
    const off = reconstructRoof(sc.raster, sc.point)!;
    const on = reconstructRoof(sc.raster, sc.point, { lidarFusion: { cloud: sc.cloud() } })!;
    expect(on.lidarFusion).toMatchObject({ applied: false, reason: 'nothing-hidden', addedPlanM2: 0 });
    expect(on.outline).toEqual(off.outline);
    expect(on.faces.map((f) => f.planAreaM2)).toEqual(off.faces.map((f) => f.planAreaM2));
    expect(on.quality.reasons).not.toContain('roof-from-lidar');
  });

  it('declines with a typed reason and leaves the layers alone', () => {
    const sc = scene({ seed: 48, turnDeg: 17, hideM: 5 });
    const off = reconstructRoof(sc.raster, sc.point)!;
    const cases: [Parameters<Scene['cloud']>[0], string][] = [
      [{ leafOff: false }, 'not-leaf-off'],
      [{ leafOff: null }, 'not-leaf-off'],
      [{ density: 1.5 }, 'sparse'],
    ];
    for (const [o, reason] of cases) {
      const on = reconstructRoof(sc.raster, sc.point, { lidarFusion: { cloud: sc.cloud(o) } })!;
      expect(on.lidarFusion).toMatchObject({ applied: false, reason });
      expect(on.outline).toEqual(off.outline);
    }
    const empty = fuseLidar(sc.raster, sc.point, { x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0), flags: new Uint8Array(0), leafOff: true });
    expect(empty.report).toMatchObject({ applied: false, reason: 'no-points' });
    expect(empty.raster).toBe(sc.raster);
    const old = fuseLidar(sc.raster, sc.point, { ...sc.cloud(), ageYears: DEFAULT_LIDAR_FUSION.maxAgeYears + 1 });
    expect(old.report.reason).toBe('too-old');
    const many = fuseLidar(sc.raster, sc.point, sc.cloud(), { ...DEFAULT_LIDAR_FUSION, maxPoints: 100 });
    expect(many.report.reason).toBe('too-many-points');
    // Lidar of another place: the frame does not register onto Google's roof.
    const other = scene({ seed: 9, turnDeg: 70, hx: 3, hy: 2 });
    const wrong = fuseLidar(sc.raster, sc.point, other.cloud({ shift: { x: 9, y: 9 } }));
    expect(wrong.report.applied).toBe(false);
    expect(wrong.lidarPx).toBeNull();
  });

  it('a roof that changed between the flight and the imagery is refused, not merged', () => {
    // Google sees the whole 12 m gable, no crown; the lidar saw a 16 m one (a part taken down since the flight): lidar
    // roof where Google's heights show smooth ground. Never added.
    const now = scene({ seed: 52, turnDeg: 12, hideM: -10 });
    const before = scene({ seed: 52, turnDeg: 12, hideM: -10, hx: 8 });
    const longer = fuseLidar(now.raster, now.point, before.cloud());
    expect(longer.report).toMatchObject({ applied: false, reason: 'changed' });
    // The lidar saw an 8 m one (built on since the flight): Google's smooth roof where the lidar sees bare ground.
    const shorter = scene({ seed: 52, turnDeg: 12, hideM: -10, hx: 3.5 });
    const built = fuseLidar(now.raster, now.point, shorter.cloud());
    expect(built.report.applied).toBe(false);
    expect(['changed', 'misaligned']).toContain(built.report.reason);
  });

  it('never adds roof where Google sees the same surface in full (a mask miss is not hidden roof)', () => {
    // Guard for minOccludedShare: a part with no crown over it is something Google's heights saw, not hidden roof.
    const sc = scene({ seed: 57, turnDeg: 5, hideM: 5 });
    // Google's heights over the crown replaced by the true roof (smooth), the mask still stopping short of it.
    const truth = scene({ seed: 57, turnDeg: 5, hideM: -10 });
    const raster = { ...sc.raster, dsm: truth.raster.dsm };
    const f = fuseLidar(raster, sc.point, sc.cloud());
    expect(f.report.applied).toBe(false);
    expect(f.report.reason).toBe('nothing-hidden');
  });

  it('refuses to add more than maxAddShare of the roof', () => {
    const sc = scene({ seed: 61, turnDeg: 0, hideM: 5 });
    const f = fuseLidar(sc.raster, sc.point, sc.cloud(), { ...DEFAULT_LIDAR_FUSION, maxAddShare: 0.2 });
    expect(f.report).toMatchObject({ applied: false, reason: 'large-change' });
  });
});
