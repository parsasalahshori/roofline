// Robustness of the reconstruction to the kinds of disturbance real Data Layers carry: the mask a pixel or half a pixel
// off the height map, a little more height noise, a different turn of the house, and coarser (MEDIUM) pixels. The plane
// search no longer reads the random seed, so "same roof for seeds 7, 8, 9" says nothing about robustness; these do.
// Each perturbation must leave the face count, every pitch and the area inside the stated tolerance, and the spread of
// the area over all perturbations of one roof is bounded too.
import { describe, expect, it } from 'vitest';
import { type RoofRaster, reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { seededRandom } from '../src/roof-reconstruct/raster.ts';
import { GABLE, HIP, L_CROSS, type Shape, type SyntheticRoof, synthesize, type XY } from './fixtures/synthetic-roofs.ts';

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The mask moved by whole pixels against the heights (registration error between Google's layers). */
function shiftMask(r: RoofRaster, dc: number, dr: number): RoofRaster {
  const mask = new Uint8Array(r.mask.length);
  for (let row = 0; row < r.height; row++) {
    for (let col = 0; col < r.width; col++) {
      const sr = row - dr;
      const sc = col - dc;
      if (sr >= 0 && sc >= 0 && sr < r.height && sc < r.width) mask[row * r.width + col] = r.mask[sr * r.width + sc]!;
    }
  }
  return { ...r, mask };
}

/** The heights moved by half a pixel east and south (bilinear), the mask left where it was. */
function halfPixelHeights(r: RoofRaster): RoofRaster {
  const dsm = new Float32Array(r.dsm.length);
  const w = r.width;
  for (let row = 0; row < r.height; row++) {
    for (let col = 0; col < w; col++) {
      const c0 = Math.max(0, col - 1);
      const r0 = Math.max(0, row - 1);
      dsm[row * w + col] = (r.dsm[row * w + col]! + r.dsm[row * w + c0]! + r.dsm[r0 * w + col]! + r.dsm[r0 * w + c0]!) / 4;
    }
  }
  return { ...r, dsm };
}

/** Seeded Gaussian height noise of `sigma` metres added on top. */
function addNoise(r: RoofRaster, sigma: number, seed: number): RoofRaster {
  const rng = seededRandom(seed);
  const dsm = Float32Array.from(r.dsm, (z) => {
    const u = Math.max(1e-12, rng());
    return z + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  });
  return { ...r, dsm };
}

/** Block-mean resampling by `f` (0.1 m -> 0.3 m for f = 3): MEDIUM-like pixels. Mask: roof when most of the block is. */
function blockMean(syn: SyntheticRoof, f: number): { raster: RoofRaster; point: { col: number; row: number } } {
  const r = syn.raster;
  const w = Math.floor(r.width / f);
  const h = Math.floor(r.height / f);
  const dsm = new Float32Array(w * h);
  const mask = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      let z = 0;
      let m = 0;
      for (let dr = 0; dr < f; dr++) {
        for (let dc = 0; dc < f; dc++) {
          const i = (row * f + dr) * r.width + col * f + dc;
          z += r.dsm[i]!;
          m += r.mask[i]! !== 0 ? 1 : 0;
        }
      }
      dsm[row * w + col] = z / (f * f);
      mask[row * w + col] = m * 2 > f * f ? 1 : 0;
    }
  }
  return { raster: { width: w, height: h, pixelSizeM: r.pixelSizeM * f, dsm, mask, green: null }, point: { col: syn.point.col / f, row: syn.point.row / f } };
}

type Variant = { name: string; raster: RoofRaster; point: { col: number; row: number }; areaTol: number };

function variants(shape: Shape): { syn: SyntheticRoof; list: Variant[] } {
  const syn = synthesize(shape, { turnDeg: 23, seed: 11, trees: 0 });
  const at = (name: string, raster: RoofRaster, areaTol = 0.02): Variant => ({ name, raster, point: syn.point, areaTol });
  const list: Variant[] = [
    at('as made', syn.raster, 0.01),
    at('mask 1 px east', shiftMask(syn.raster, 1, 0)),
    at('mask 1 px south', shiftMask(syn.raster, 0, 1)),
    at('heights half a pixel off', halfPixelHeights(syn.raster)),
    at('+1 cm noise', addNoise(syn.raster, 0.01, 101)),
    at('+2 cm noise', addNoise(syn.raster, 0.02, 102)),
    at('+3 cm noise', addNoise(syn.raster, 0.03, 103)),
  ];
  for (const turnDeg of [5, 15, 30]) {
    const t = synthesize(shape, { turnDeg, seed: 11, trees: 0 });
    list.push({ name: `turned ${turnDeg} deg`, raster: t.raster, point: t.point, areaTol: 0.01 });
  }
  return { syn, list };
}

describe('reconstruction under perturbation (replaces seed variance as the robustness signal)', () => {
  for (const shape of [GABLE, HIP, L_CROSS]) {
    it(`${shape.name}: face count, pitch and area hold under jitter, noise and turns; area spread is small`, () => {
      const { syn, list } = variants(shape);
      const areas: number[] = [];
      for (const v of list) {
        const r = reconstructRoof(v.raster, v.point, { seed: 7 });
        expect(r, `${shape.name} ${v.name}`).not.toBeNull();
        expect(r!.faces.length, `${shape.name} ${v.name}: faces`).toBe(syn.faces.length);
        for (const f of r!.faces) {
          const truth = syn.faces.find((t) => Math.abs(t.pitchX12 - f.pitchX12) < 0.5);
          expect(truth, `${shape.name} ${v.name}: pitch ${f.pitchX12.toFixed(2)}`).toBeDefined();
        }
        const area = r!.faces.reduce((t, f) => t + f.planAreaM2, 0) / syn.planAreaM2 - 1;
        expect(Math.abs(area), `${shape.name} ${v.name}: area ${(area * 100).toFixed(2)}%`).toBeLessThan(v.areaTol);
        areas.push(area);
      }
      // The spread (max - min) of the area error over every perturbation: the robustness number the bench reports.
      expect(Math.max(...areas) - Math.min(...areas), `${shape.name}: area spread`).toBeLessThan(0.025);
    });
  }

  for (const shape of [GABLE, HIP]) {
    it(`${shape.name}: block-mean resampled to 0.3 m (MEDIUM-like) keeps every face and pitch`, () => {
      const syn = synthesize(shape, { turnDeg: 23, seed: 11, trees: 0 });
      const coarse = blockMean(syn, 3);
      const r = reconstructRoof(coarse.raster, coarse.point, { seed: 7 });
      expect(r, shape.name).not.toBeNull();
      expect(r!.faces.length).toBe(syn.faces.length);
      for (const truth of syn.faces) {
        const face = r!.faces.find((f) => inside(syn.toLocal(truth.probe), f.ring));
        expect(face, truth.name).toBeDefined();
        expect(Math.abs(face!.pitchX12 - truth.pitchX12)).toBeLessThan(0.5);
      }
      const area = r!.faces.reduce((t, f) => t + f.planAreaM2, 0) / syn.planAreaM2 - 1;
      expect(Math.abs(area)).toBeLessThan(0.03);
    });
  }
});
