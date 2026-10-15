// A real notch in an eave with a tree crown standing in it (review finding: "hidden-edge inference invents roof").
// The notch's inner eave lies on the same plane as the rest of the face, higher up, so to the planes step it looks
// exactly like a crown bite out of the eave: the heights under a dense crown show crown, not the yard, and the photo
// is leaf-on. From the heights alone a dense crown over a real eave and a dense crown in a notch are the same scene, so
// roof added more than an overhang beyond what the mask kept is a hypothesis: it needs the roof's plane seen through
// the leaves, or it is not added. Whatever the step does add is recorded as inferred and, past a few square metres,
// sent for review ('roof-inferred'). At 0.1 m (HIGH) and 0.25 m (MEDIUM).
import { describe, expect, it } from 'vitest';
import { reconstructRoof, type RoofRaster } from '../src/roof-reconstruct/index.ts';
import { synthesize, type Shape, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

const L = 16;
const W = 10;
const P = 6;

/** The hip of the planes tests (16 x 10 m at 6/12) with an open recess `nw` x `nd` metres cut out of its south eave. */
function notchedHip(nw: number, nd: number): Shape {
  return {
    name: `hip ${L}x${W} @${P}, notch ${nw}x${nd}`,
    extent: 11,
    height: ({ x, y }: XY) => {
      if (Math.abs(x) > L / 2 || Math.abs(y) > W / 2) return null;
      if (Math.abs(x) <= nw / 2 && y < -W / 2 + nd) return null;
      return 3 + Math.min(W / 2 - Math.abs(y), L / 2 - Math.abs(x)) * (P / 12);
    },
    faces: [],
    lines: {},
    planAreaM2: L * W - nw * nd,
  };
}

/** A dense crown (no gaps) of radius `rad` standing in the notch over the yard only: the roof keeps its mask. */
function crownInNotch(roof: SyntheticRoof, at: XY, rad: number): RoofRaster {
  const { width: w, height: h, pixelSizeM: s } = roof.raster;
  const dsm = Float32Array.from(roof.raster.dsm);
  const mask = Uint8Array.from(roof.raster.mask);
  const green = new Uint8Array(w * h);
  const c = roof.toLocal(at);
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      const x = (col + 0.5) * s;
      const y = -(r + 0.5) * s;
      const d = Math.hypot(x - c.x, y - c.y);
      const i = r * w + col;
      if (d > rad || roof.raster.mask[i] === 1) continue;
      const z = 7 - (d * d) / (rad * 1.5) + 0.25 * Math.sin(x * 7.3) * Math.cos(y * 6.1);
      if (z > dsm[i]!) {
        dsm[i] = z;
        green[i] = 1;
      }
    }
  }
  return { width: w, height: h, pixelSizeM: s, dsm, mask, green };
}

function area(ring: readonly XY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) a += ring[i]!.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * ring[i]!.y;
  return Math.abs(a) / 2;
}

describe('a real notch with a dense crown standing in it is not filled by the hidden-edge step', () => {
  for (const px of [0.1, 0.25]) {
    for (const [nw, nd, rad] of [
      [4, 2, 2.8],
      [5, 1.5, 3],
      [3, 2.5, 2.2],
    ] as const) {
      for (const method of ['planes', 'photo+planes'] as const) {
        it(`${px} m pixels, notch ${nw} x ${nd} m, crown r ${rad} m, ${method}: the area stays the notched roof's`, () => {
          const shape = notchedHip(nw, nd);
          const roof = synthesize(shape, { pixelM: px, turnDeg: 0, trees: 0, noiseM: 0.02, seed: 5 });
          const raster = crownInNotch(roof, { x: 0, y: -W / 2 + nd / 2 }, rad);
          const off = reconstructRoof(raster, roof.point, {})!;
          const on = reconstructRoof(raster, roof.point, { hiddenEdge: { method } })!;
          expect(off).not.toBeNull();
          expect(on).not.toBeNull();
          // Without the step the outline follows the notch (within 1 % of the true area).
          expect(Math.abs(area(off.outline) - shape.planAreaM2) / shape.planAreaM2).toBeLessThan(0.01);
          // With it, the notch is not filled: no more than a pixel's worth of change, or a review reason if it is.
          const added = area(on.outline) - area(off.outline);
          if (added > 1) expect(on.quality.reasons).toContain('roof-inferred');
          expect(added).toBeLessThan(1);
        });
      }
    }
  }
});
