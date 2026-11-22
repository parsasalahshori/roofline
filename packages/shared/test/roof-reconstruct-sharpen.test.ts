// Sharpening the heights before the plane search (sharpen.ts): a crest the height map rounded is filled out to its
// faces' planes, a plain slope is left as it is, a small bump is never flattened into the face round it, and the
// roof's edge and tree crowns are not touched. The synthetic roofs carry the fixture's 5 x 5 blur with 2 mm of noise:
// Google's maps are that smooth at the half-metre scale (a 0.5 m window fits a plane within 2 mm on faces), where the
// fixture's default 3 cm of white noise would leave no window planar.
import { describe, expect, it } from 'vitest';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { DEFAULT_PLANE_PARAMS, findPlanes } from '../src/roof-reconstruct/planes.ts';
import { seededRandom } from '../src/roof-reconstruct/raster.ts';
import { DEFAULT_SHARPEN, sharpenHeights, type SharpenParams } from '../src/roof-reconstruct/sharpen.ts';
import { DORMER_GABLE } from './fixtures/hard-roofs.ts';
import { BOWED_GABLE, GABLE, HIP, L_CROSS, type Shape, synthesize } from './fixtures/synthetic-roofs.ts';

const ON: SharpenParams = { ...DEFAULT_SHARPEN, enabled: true };

/** A shape on an unturned grid with its true heights, the fixture's blur and smooth noise. */
function smooth(shape: Shape, o: { pixelM?: number; noiseM?: number; seed?: number } = {}) {
  const syn = synthesize(shape, { turnDeg: 0, noiseM: o.noiseM ?? 0, ...(o.pixelM !== undefined ? { pixelM: o.pixelM } : {}), ...(o.seed !== undefined ? { seed: o.seed } : {}) });
  const { width: w, height: h, pixelSizeM: s } = syn.raster;
  const c = syn.toLocal({ x: 0, y: 0 });
  // Unturned: house X, Y = local x - c.x, y - c.y.
  const truth = new Float64Array(w * h).fill(Number.NaN);
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const z = shape.height({ x: (col + 0.5) * s - c.x, y: -(r + 0.5) * s - c.y });
      if (z !== null) truth[r * w + col] = z;
    }
  }
  return { syn, w, h, s, truth, house: (i: number) => ({ x: ((i % w) + 0.5) * s - c.x, y: -(Math.floor(i / w) + 0.5) * s - c.y }) };
}

describe('sharpenHeights', () => {
  it('fills a rounded ridge out to its two faces (cleanWindows)', () => {
    const { syn, w, h, truth, house } = smooth(GABLE);
    const out = sharpenHeights({ w, h }, syn.raster.pixelSizeM, syn.raster.dsm, syn.raster.mask, null, { ...ON, cleanWindows: true });
    let before = 0;
    let after = 0;
    for (let i = 0; i < w * h; i++) {
      const p = house(i);
      // The crest, away from the gable ends.
      if (!(Math.abs(p.y) <= 0.1 && Math.abs(p.x) <= 5)) continue;
      before = Math.max(before, truth[i]! - syn.raster.dsm[i]!);
      after = Math.max(after, Math.abs(truth[i]! - out[i]!));
    }
    // The 5 x 5 blur takes 0.04 m off the crest's pixels; the planes on either side put it back.
    expect(before).toBeGreaterThan(0.03);
    expect(after).toBeLessThan(0.01);
  });

  it('leaves a plain slope and the inside of every face as they are', () => {
    const { syn, w, h, house } = smooth(GABLE, { noiseM: 0.002 });
    const out = sharpenHeights({ w, h }, syn.raster.pixelSizeM, syn.raster.dsm, syn.raster.mask, null, ON);
    let changed = 0;
    let away = 0;
    for (let i = 0; i < w * h; i++) {
      if (out[i] === syn.raster.dsm[i]) continue;
      changed++;
      if (Math.abs(house(i).y) > 0.6) away++;
    }
    expect(changed).toBeGreaterThan(0);
    // Only the crest moves: nothing on the slopes more than 0.6 m from the ridge.
    expect(away).toBe(0);
  });

  it('never flattens a dormer into the slope round it, and leaves the edge and tree crowns alone', () => {
    const { syn, w, h, s } = smooth(DORMER_GABLE, { noiseM: 0.002 });
    const mask = syn.raster.mask;
    const tree = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (i % w < w / 2) tree[i] = 1;
    const out = sharpenHeights({ w, h }, s, syn.raster.dsm, mask, tree, ON);
    const out0 = sharpenHeights({ w, h }, s, syn.raster.dsm, mask, null, ON);
    let lowered = 0;
    let onEdge = 0;
    let onTree = 0;
    let raised = 0;
    const r = Math.round(ON.edgeM / s);
    for (let i = 0; i < w * h; i++) {
      if (out0[i]! < syn.raster.dsm[i]!) lowered++;
      if (out0[i]! > syn.raster.dsm[i]!) raised++;
      if (tree[i] === 1 && out[i] !== syn.raster.dsm[i]) onTree++;
      if (out0[i] === syn.raster.dsm[i]) continue;
      // Within edgeM of a pixel off the roof?
      const c = i % w;
      const row = Math.floor(i / w);
      for (let dr = -r; dr <= r && onEdge === 0; dr++) for (let dc = -r; dc <= r; dc++) if (mask[(row + dr) * w + c + dc] !== 1) { onEdge++; break; }
    }
    expect(raised).toBeGreaterThan(0);
    expect(lowered).toBe(0);
    expect(onEdge).toBe(0);
    expect(onTree).toBe(0);
  });

  it('is deterministic and leaves its input untouched', () => {
    const { syn, w, h, s } = smooth(DORMER_GABLE, { noiseM: 0.002 });
    const copy = Float32Array.from(syn.raster.dsm);
    const a = sharpenHeights({ w, h }, s, syn.raster.dsm, syn.raster.mask, null, ON);
    const b = sharpenHeights({ w, h }, s, syn.raster.dsm, syn.raster.mask, null, ON);
    expect(a.some((v, i) => v !== copy[i])).toBe(true);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(syn.raster.dsm)).toEqual(Array.from(copy));
    // Off: the heights as they came.
    expect(Array.from(sharpenHeights({ w, h }, s, syn.raster.dsm, syn.raster.mask, null, DEFAULT_SHARPEN))).toEqual(Array.from(copy));
  });

  it('works on 0.25 m pixels (MEDIUM imagery)', () => {
    const { syn, w, h, truth, house } = smooth(GABLE, { pixelM: 0.25 });
    const out = sharpenHeights({ w, h }, 0.25, syn.raster.dsm, syn.raster.mask, null, { ...ON, cleanWindows: true });
    let before = 0;
    let after = 0;
    for (let i = 0; i < w * h; i++) {
      const p = house(i);
      if (!(Math.abs(p.y) <= 0.25 && Math.abs(p.x) <= 4)) continue;
      before = Math.max(before, truth[i]! - syn.raster.dsm[i]!);
      after = Math.max(after, Math.abs(truth[i]! - out[i]!));
    }
    expect(after).toBeLessThan(before / 2);
  });
});

describe('sharpen in the reconstruction', () => {
  const faces = (shape: Shape, seed: number, on: boolean): number => {
    const syn = synthesize(shape, { seed, noiseM: 0.002 });
    return reconstructRoof(syn.raster, syn.point, on ? { sharpen: { enabled: true } } : {})?.faces.length ?? 0;
  };

  it('finds a small gable dormer the blur rounded into its slope', () => {
    // The dormer's faces are about 3 m2 at 8/12 on a 6/12 slope. Seeds 1-6: found 4 times with sharpening, never without.
    let off = 0;
    let on = 0;
    for (let seed = 1; seed <= 6; seed++) {
      if (faces(DORMER_GABLE, seed, false) >= 4) off++;
      if (faces(DORMER_GABLE, seed, true) >= 4) on++;
    }
    expect(off).toBe(0);
    expect(on).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it('keeps a plain gable, a hip and a bowed gable as they are, where the dormer roof gains its dormer', () => {
    for (const shape of [GABLE, HIP, BOWED_GABLE]) {
      for (const seed of [11, 12]) expect(faces(shape, seed, true)).toBe(faces(shape, seed, false));
    }
    expect(faces(DORMER_GABLE, 1, true)).toBeGreaterThan(faces(DORMER_GABLE, 1, false));
  }, 120_000);
});

describe('plane search study switches (defaults unchanged)', () => {
  it('freeErodeM 0 lets a plane reach the roof edge; innerPatch off takes the pixels by a crease too', () => {
    // An unblurred 6/12 plane on a 10 x 8 m rectangle: only the search's 0.2 m start-in keeps patches off its edge.
    const w = 120;
    const h = 100;
    const s = 0.1;
    const dsm = new Float32Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let r = 10; r < 90; r++) for (let c = 10; c < 110; c++) { mask[r * w + c] = 1; dsm[r * w + c] = 3 + 0.5 * (r - 10) * s; }
    const edgePx = (o: object): number => {
      let n = 0;
      for (const f of findPlanes({ w, h }, s, dsm, mask, seededRandom(7), { ...DEFAULT_PLANE_PARAMS, ...o })) {
        for (let i = 0; i < f.patch.length; i++) if (f.patch[i] === 1 && (mask[i - 1] !== 1 || mask[i + 1] !== 1 || mask[i - w] !== 1 || mask[i + w] !== 1)) n++;
      }
      return n;
    };
    expect(edgePx({})).toBe(0);
    expect(edgePx({ freeErodeM: 0 })).toBeGreaterThan(0);
    const syn = synthesize(L_CROSS, { seed: 11 });
    const { width: W, height: H, pixelSizeM: S } = syn.raster;
    const total = (o: object): number => findPlanes({ w: W, h: H }, S, syn.raster.dsm, syn.raster.mask, seededRandom(7), { ...DEFAULT_PLANE_PARAMS, ...o }).reduce((a, f) => a + f.patch.reduce((x, v) => x + v, 0), 0);
    expect(total({ innerPatch: false })).toBeGreaterThan(total({}));
  });
});
