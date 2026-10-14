// Faces the height map makes hard: steep faces whose heights scatter more than tolM, and small dormer faces.
import { describe, expect, it } from 'vitest';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { DEFAULT_PLANE_PARAMS, findPlanes, slopeOf } from '../src/roof-reconstruct/planes.ts';
import { seededRandom } from '../src/roof-reconstruct/raster.ts';
import { DORMER_GABLE } from './fixtures/hard-roofs.ts';
import { synthesize } from './fixtures/synthetic-roofs.ts';

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * A gable 10 x 8 m, ridge along x, at `pitch`/12, raw (no blur) with Gaussian height noise `noiseM`: the roof mask is
 * the whole house. Pixels 0.1 m.
 */
function roughGable(pitch: number, noiseM: number, seed: number) {
  const s = 0.1;
  const W = 140;
  const H = 120;
  const rng = seededRandom(seed);
  const dsm = new Float32Array(W * H);
  const roof = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = (c + 0.5) * s - 7;
      const y = -(r + 0.5) * s + 6;
      const i = r * W + c;
      if (Math.abs(x) > 5 || Math.abs(y) > 4) continue;
      roof[i] = 1;
      const u = Math.max(1e-12, rng());
      const v = rng();
      dsm[i] = 3 + (4 - Math.abs(y)) * (pitch / 12) + noiseM * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
  }
  return { g: { w: W, h: H }, s, dsm, roof };
}

describe('findPlanes: the rescue pass for faces rougher than tolM', () => {
  it('finds both faces of a rough 12/12 gable at their pitch, where tolM alone finds none', () => {
    const { g, s, dsm, roof } = roughGable(12, 0.09, 3);
    const strict = findPlanes(g, s, dsm, roof, seededRandom(7), { ...DEFAULT_PLANE_PARAMS, rescueTolX: 0 });
    expect(strict.length).toBe(0);
    const found = findPlanes(g, s, dsm, roof, seededRandom(7), DEFAULT_PLANE_PARAMS);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const big = found.filter((f) => f.patch.reduce((t, v) => t + v, 0) * s * s > 10);
    expect(big.length).toBe(2);
    for (const f of big) expect(Math.abs(slopeOf(f.plane) * 12 - 12)).toBeLessThan(0.5);
    // One face each way: north and south.
    expect(Math.sign(big[0]!.plane.b)).toBe(-Math.sign(big[1]!.plane.b));
  });

  it('leaves a clean roof to the first pass (the rescue pass adds nothing there)', () => {
    const { g, s, dsm, roof } = roughGable(6, 0.02, 4);
    const a = findPlanes(g, s, dsm, roof, seededRandom(7), DEFAULT_PLANE_PARAMS);
    const b = findPlanes(g, s, dsm, roof, seededRandom(7), { ...DEFAULT_PLANE_PARAMS, rescueTolX: 0 });
    expect(a.map((f) => f.plane)).toEqual(b.map((f) => f.plane));
    expect(a.length).toBe(2);
  });
});

// (A dormer face whose RANSAC patch comes out under minPlaneM2 is still not found: at some turns one of these faces
// does; lowering minPlaneM2 to 1.5-1.75 m2 found them but made junk faces on real roofs.)
describe('reconstructRoof: a small dormer is a face of its own', () => {
  for (const [turnDeg, seed] of [
    [17, 11],
    [17, 5],
    [45, 11],
    [30, 5],
    [0, 3],
  ] as const) {
    it(`keeps both dormer faces (about 3 m2 each) at their own pitch and facing (turned ${turnDeg}, seed ${seed})`, () => {
      const syn = synthesize(DORMER_GABLE, { turnDeg, seed, trees: 0 });
      const roof = reconstructRoof(syn.raster, syn.point);
      expect(roof).not.toBeNull();
      // Each true face matched by its facing (the dormer's faces are drawn by the topology, so look them up by plane).
      for (const truth of DORMER_GABLE.faces) {
        const f = roof!.faces.find((c) => arc(c.azimuthDeg, syn.azimuth(truth.downDeg)) < 6 && Math.abs(c.pitchX12 - truth.pitchX12) < 0.75);
        expect(f, `${truth.name}: ${roof!.faces.map((c) => `${c.pitchX12.toFixed(1)}@${c.azimuthDeg.toFixed(0)}`).join(' ')}`).toBeDefined();
        expect(Math.abs(f!.planAreaM2 / truth.planAreaM2 - 1), `${truth.name} area ${f!.planAreaM2}`).toBeLessThan(0.35);
      }
      // Four faces, no junk under 25 sq ft, and the whole roof.
      expect(roof!.faces.length).toBe(4);
      for (const f of roof!.faces) expect(f.planAreaM2).toBeGreaterThanOrEqual(2.32);
      expect(Math.abs(roof!.faces.reduce((t, f) => t + f.planAreaM2, 0) / DORMER_GABLE.planAreaM2 - 1)).toBeLessThan(0.02);
    });
  }

  it('merges the dormer away when the small-feature rules are off (what the rules are for)', () => {
    const syn = synthesize(DORMER_GABLE, { turnDeg: 17, seed: 11, trees: 0 });
    const roof = reconstructRoof(syn.raster, syn.point, { planes: { smallKeepDeg: 0 } });
    expect(roof!.faces.length).toBe(2);
  });
});
