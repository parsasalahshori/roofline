// Synthetic roofs with small features a height map blurs away, for the fitted-shapes tests
// (roof-reconstruct-shapes.test.ts): a gable bump-out on a hip roof, a hip roof with small end faces. Google's height
// map is far softer than the 0.5 m box the other fixtures round their creases with: `soften` blurs a synthetic
// roof's heights again, the way a feature a couple of metres across reaches the engine.
import type { RoofRaster } from '../../src/roof-reconstruct/index.ts';
import { hipShape, type Shape, type SyntheticRoof, type XY } from './synthetic-roofs.ts';

const EAVE = 3;

/**
 * The roof's heights box-blurred `passes` times over a window of 2 * radiusM + one pixel, roof pixels among
 * themselves (the yard stays out of it and stays as it was: the roof's edge keeps its height, its creases are rounded
 * off and its small faces melt into their neighbours), then `lumpsM` of swell added to the roof.
 */
export function soften(syn: SyntheticRoof, radiusM: number, passes = 2, lumpsM = 0): SyntheticRoof {
  const { width: W, height: H, pixelSizeM: s, mask } = syn.raster;
  const k = Math.max(1, Math.round(radiusM / s));
  let src = Float32Array.from(syn.raster.dsm);
  // Running sums along one axis of `from` times the mask, and of the mask itself.
  const pass1d = (from: Float32Array, weight: Float32Array, along: 'rows' | 'cols'): { sum: Float32Array; n: Float32Array } => {
    const sum = new Float32Array(W * H);
    const n = new Float32Array(W * H);
    const outer = along === 'rows' ? H : W;
    const inner = along === 'rows' ? W : H;
    const at = (o: number, i: number) => (along === 'rows' ? o * W + i : i * W + o);
    for (let o = 0; o < outer; o++) {
      let acc = 0;
      let cnt = 0;
      for (let i = -k; i < inner; i++) {
        const add = i + k;
        if (add < inner) {
          acc += from[at(o, add)]!;
          cnt += weight[at(o, add)]!;
        }
        const drop = i - k - 1;
        if (drop >= 0) {
          acc -= from[at(o, drop)]!;
          cnt -= weight[at(o, drop)]!;
        }
        if (i >= 0) {
          sum[at(o, i)] = acc;
          n[at(o, i)] = cnt;
        }
      }
    }
    return { sum, n };
  };
  const roofOnly = Float32Array.from(mask, (m) => (m !== 0 ? 1 : 0));
  for (let pass = 0; pass < passes; pass++) {
    const masked = src.map((z, i) => (mask[i] !== 0 ? z : 0));
    const rows = pass1d(masked, roofOnly, 'rows');
    const both = pass1d(rows.sum, rows.n, 'cols');
    src = src.map((z, i) => (mask[i] !== 0 && both.n[i]! > 0 ? both.sum[i]! / both.n[i]! : z));
  }
  // Lumps: the height map's own error is not white noise but swells a metre or two across (`lumpsM` high at most).
  if (lumpsM > 0) {
    src = src.map((z, i) => {
      if (mask[i] === 0) return z;
      const x = (i % W) * s;
      const y = Math.floor(i / W) * s;
      return z + (lumpsM / 2) * (Math.sin(x * 3.1 + y * 1.3) + Math.sin(x * 1.7 - y * 2.9 + 1));
    });
  }
  const raster: RoofRaster = { ...syn.raster, dsm: src };
  return { ...syn, raster };
}

/**
 * A hip roof 16 x 10 m at 6/12 (ridge along X) with a gable over a bump-out on its south side: the bump-out is
 * 2 * half wide and `depth` deep, its gable at `pitch`/12 with the ridge along Y at X 0 and its eaves at the main
 * eave's height, running back into the south slope in two valleys.
 */
export function hipWithGableBump(half: number, depth: number, pitch: number): Shape & { bump: { half: number; depth: number; back: number; rise: number } } {
  const q = pitch / 12;
  const rise = half * q;
  // The gable's ridge meets the south slope where that slope (rising at 0.5 from the eave at Y -5) reaches its height.
  const back = -5 + rise / 0.5;
  const side = half * depth + (half * (back + 5)) / 2;
  return {
    name: `hip roof with a ${2 * half} m gable bump-out @${pitch}`,
    extent: 12,
    height: ({ x, y }: XY) => {
      const inMain = Math.abs(x) <= 8 && Math.abs(y) <= 5;
      const main = inMain ? EAVE + Math.min(5 - Math.abs(y), 8 - Math.abs(x)) * 0.5 : -Infinity;
      const inBump = Math.abs(x) <= half && y >= -5 - depth && y <= back;
      const bump = inBump ? EAVE + (half - Math.abs(x)) * q : -Infinity;
      const z = Math.max(main, bump);
      return Number.isFinite(z) ? z : null;
    },
    faces: [
      { name: 'north', probe: { x: 0, y: 3 }, pitchX12: 6, downDeg: 90, planAreaM2: 55 },
      { name: 'east', probe: { x: 6.5, y: 0 }, pitchX12: 6, downDeg: 0, planAreaM2: 25 },
      { name: 'west', probe: { x: -6.5, y: 0 }, pitchX12: 6, downDeg: 180, planAreaM2: 25 },
      { name: 'bump east', probe: { x: half / 2, y: -5 - depth / 2 }, pitchX12: pitch, downDeg: 0, planAreaM2: side },
      { name: 'bump west', probe: { x: -half / 2, y: -5 - depth / 2 }, pitchX12: pitch, downDeg: 180, planAreaM2: side },
    ],
    // The whole roof's ridges (the main one and the bump-out's), the bump-out's two valleys and its rakes (true lengths).
    lines: { ridge: 6 + depth + (back + 5), valley: 2 * Math.hypot(half, back + 5, rise), rake: 2 * Math.hypot(half, rise) },
    planAreaM2: 160 + 2 * half * depth,
    bump: { half, depth, back, rise },
  };
}

/** A hip roof 15 x 5 m at 6/12: its two end faces are triangles 5 m wide and 2.5 m deep (6.25 m2 each). */
export const NARROW_HIP: Shape = hipShape(15, 5, 6);
