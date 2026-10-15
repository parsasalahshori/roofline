// A synthetic scene for the lidar hidden-edge tests (roof-reconstruct-lidar.test.ts): a gable with one end or side
// under a crown, Google-like layers of it, and a leaf-off lidar cloud of the true roof in another frame. Seeded only.
import type { LidarCloud } from '../../src/roof-reconstruct/outline-lidar.ts';

export type XY = { x: number; y: number };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

export type Scene = {
  raster: { width: number; height: number; pixelSizeM: number; dsm: Float32Array; mask: Uint8Array };
  point: { col: number; row: number };
  /** True plan area of the roof, m2. */
  areaM2: number;
  cloud: (o?: { density?: number; leafOff?: boolean | null; shift?: XY; dz?: number; seed?: number }) => LidarCloud;
  /** House frame to raster metres. */
  toLocal: (p: XY) => XY;
  toHouse: (p: XY) => XY;
};

/**
 * Flat ground at 0, a gable (ridge along the house's x axis, turned by `turnDeg`) of half-length `hx` and half-depth
 * `hy` at `pitch`/12, eaves 3 m up, a 3 x 3 box blur and 3 cm noise. A crown covers the house frame's x > hx - `hideM`
 * (a row of trees over that end, `crownM` metres past the roof each side): Google's heights there are the canopy
 * (6-9 m, rough) and its mask has no roof there.
 */
export function scene(o: { seed: number; turnDeg: number; pixelM?: number; hx?: number; hy?: number; pitch?: number; hideM?: number; side?: 'end' | 'eave' }): Scene {
  const s = o.pixelM ?? 0.1;
  const hx = o.hx ?? 6;
  const hy = o.hy ?? 4;
  const pitch = o.pitch ?? 6;
  const hide = o.hideM ?? 2;
  const size = 2 * Math.hypot(hx, hy) + 14;
  const W = Math.ceil(size / s);
  const H = W;
  const turn = (o.turnDeg * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const cx = size / 2;
  const cy = -size / 2;
  const toLocal = (p: XY): XY => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos });
  const toHouse = (p: XY): XY => ({ x: (p.x - cx) * cos + (p.y - cy) * sin, y: -(p.x - cx) * sin + (p.y - cy) * cos });
  const roofZ = (p: XY): number | null => (Math.abs(p.x) <= hx && Math.abs(p.y) <= hy ? 3 + (hy - Math.abs(p.y)) * (pitch / 12) : null);
  // The crown: over the house's east end ('end', across the ridge: a rake) or its north side ('eave').
  const inCrown = (p: XY): boolean =>
    o.side === 'eave' ? p.y > hy - hide && p.y < hy + 3 && Math.abs(p.x) < hx + 3 : p.x > hx - hide && p.x < hx + 3 && Math.abs(p.y) < hy + 3;
  const r = rng(o.seed);
  const clean = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  const crown = new Uint8Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let c = 0; c < W; c++) {
      const p = toHouse({ x: (c + 0.5) * s, y: -(row + 0.5) * s });
      const z = roofZ(p);
      clean[row * W + c] = z ?? 0;
      if (inCrown(p)) crown[row * W + c] = 1;
      else if (z !== null) mask[row * W + c] = 1;
    }
  }
  const dsm = new Float32Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let c = 0; c < W; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = row + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          sum += clean[rr * W + cc]!;
          n++;
        }
      }
      const i = row * W + c;
      // Canopy: 6-9 m and rough (leaf-on in the photo's season).
      dsm[i] = crown[i] === 1 ? 7.5 + 1.5 * Math.sin(c * s * 1.7) * Math.cos(row * s * 1.3) + 0.25 * gauss(r) : sum / n + 0.03 * gauss(r);
    }
  }
  const cloud = (q: { density?: number; leafOff?: boolean | null; shift?: XY; dz?: number; seed?: number } = {}): LidarCloud => {
    const rr = rng(q.seed ?? o.seed + 100);
    const density = q.density ?? 16;
    const step = 1 / Math.sqrt(density);
    const shift = q.shift ?? { x: 0.7, y: -0.4 };
    const dz = q.dz ?? 31.2;
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const fs: number[] = [];
    for (let y = -step / 2; y > -size; y -= step) {
      for (let x = step / 2; x < size; x += step) {
        const px = x + (rr() - 0.5) * step;
        const py = y + (rr() - 0.5) * step;
        const p = toHouse({ x: px, y: py });
        const z = roofZ(p);
        // Bare branches over the crown area: some pulses end in a branch (a last return in the tree), most go on.
        if (inCrown(p) && rr() < 0.4) {
          xs.push(px - shift.x);
          ys.push(py - shift.y);
          zs.push((z ?? 0) + 0.5 + rr() * 5 - dz);
          const last = rr() < 0.15;
          fs.push(last ? 1 : 0);
          if (last) continue;
        }
        xs.push(px - shift.x);
        ys.push(py - shift.y);
        zs.push((z ?? 0) + 0.04 * gauss(rr) - dz);
        fs.push(z === null ? 3 : 1);
      }
    }
    return { x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs), flags: Uint8Array.from(fs), leafOff: q.leafOff === undefined ? true : q.leafOff, ageYears: 1 };
  };
  return { raster: { width: W, height: H, pixelSizeM: s, dsm, mask }, point: { col: W / 2, row: H / 2 }, areaM2: 4 * hx * hy, cloud, toLocal, toHouse };
}

