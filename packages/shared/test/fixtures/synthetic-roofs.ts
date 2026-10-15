// Synthetic height maps of roofs with exact ground truth, for the roof reconstruction tests. Each roof is a height
// function in its own house frame (metres; X along the house, Y across it), turned and placed on a 0.1 m grid the way
// Google Solar's Data Layers come: heights in metres above a ground at 0, a roof mask, measurement noise, creases
// rounded off by a small blur, and a few tree crowns leaning over the roof's edge.
import type { RoofRaster } from '../../src/roof-reconstruct/index.ts';

export type XY = { x: number; y: number };
export type TruthFace = {
  name: string;
  /** A point well inside the face, house frame. */
  probe: XY;
  pitchX12: number;
  /** Downhill direction in the house frame, degrees from +X towards +Y. */
  downDeg: number;
  planAreaM2: number;
  flat?: boolean;
};
export type TruthLines = Partial<Record<'ridge' | 'hip' | 'valley' | 'eave' | 'rake' | 'flashing' | 'step-flashing' | 'flat-edge', number>>;
export type SyntheticRoof = {
  name: string;
  raster: RoofRaster;
  point: { col: number; row: number };
  faces: TruthFace[];
  /** True (3D) length of each kind of line, metres. */
  lines: TruthLines;
  /** Plan area of the whole roof, square metres. */
  planAreaM2: number;
  /** House frame to raster-local metres (x east from the left edge, y north from the top edge). */
  toLocal: (p: XY) => XY;
  /** A face's downhill azimuth (compass degrees) from its house-frame direction. */
  azimuth: (downDeg: number) => number;
};

export type Shape = {
  name: string;
  /** Roof height above the ground at a house-frame point, or null off the roof. */
  height: (p: XY) => number | null;
  /** Half extent of the house (for sizing the grid), metres. */
  extent: number;
  faces: TruthFace[];
  lines: TruthLines;
  planAreaM2: number;
};

const EAVE = 3;
const SQRT = Math.sqrt;

/** A gable L x W metres at pitch p/12, ridge along X. */
export function gableShape(L: number, W: number, p: number): Shape {
  const run = W / 2;
  const rise = run * (p / 12);
  return {
    name: `gable ${L}x${W} @${p}`,
    extent: Math.max(L, W) / 2 + 3,
    height: ({ x, y }: XY) => (Math.abs(x) <= L / 2 && Math.abs(y) <= W / 2 ? 3 + (W / 2 - Math.abs(y)) * (p / 12) : null),
    faces: [1, -1].map((k): TruthFace => ({ name: k > 0 ? 'north' : 'south', probe: { x: 0, y: (k * W) / 4 }, pitchX12: p, downDeg: k * 90, planAreaM2: (L * W) / 2 })),
    lines: { ridge: L, eave: 2 * L, rake: 4 * Math.hypot(run, rise) },
    planAreaM2: L * W,
  };
}

/** A hip roof L x W metres (L > W) at pitch p/12: two trapezoids, two triangles, a ridge of L - W. */
export function hipShape(L: number, W: number, p: number): Shape {
  const run = W / 2;
  const hipLen = Math.hypot(run * Math.SQRT2, run * (p / 12));
  return {
    name: `hip ${L}x${W} @${p}`,
    extent: Math.max(L, W) / 2 + 3,
    height: ({ x, y }: XY) => (Math.abs(x) <= L / 2 && Math.abs(y) <= W / 2 ? 3 + Math.min(W / 2 - Math.abs(y), L / 2 - Math.abs(x)) * (p / 12) : null),
    faces: [
      { name: 'north', probe: { x: 0, y: W / 3 }, pitchX12: p, downDeg: 90, planAreaM2: ((L + (L - W)) / 2) * run },
      { name: 'south', probe: { x: 0, y: -W / 3 }, pitchX12: p, downDeg: -90, planAreaM2: ((L + (L - W)) / 2) * run },
      { name: 'east', probe: { x: L / 2 - run / 3, y: 0 }, pitchX12: p, downDeg: 0, planAreaM2: run * run },
      { name: 'west', probe: { x: -L / 2 + run / 3, y: 0 }, pitchX12: p, downDeg: 180, planAreaM2: run * run },
    ],
    lines: { ridge: L - W, hip: 4 * hipLen, eave: 2 * (L + W) },
    planAreaM2: L * W,
  };
}

/** A gable 14 x 9 m at 6/12, ridge along X. */
export const GABLE: Shape = {
  name: 'gable',
  extent: 10,
  height: ({ x, y }) => (Math.abs(x) <= 7 && Math.abs(y) <= 4.5 ? EAVE + (4.5 - Math.abs(y)) * 0.5 : null),
  faces: [
    { name: 'north', probe: { x: 0, y: 2 }, pitchX12: 6, downDeg: 90, planAreaM2: 63 },
    { name: 'south', probe: { x: 0, y: -2 }, pitchX12: 6, downDeg: -90, planAreaM2: 63 },
  ],
  lines: { ridge: 14, eave: 28, rake: 4 * SQRT(4.5 ** 2 + 2.25 ** 2) },
  planAreaM2: 126,
};

/** A hip roof 16 x 10 m at 5/12: two trapezoids, two triangles, a 6 m ridge. */
export const HIP: Shape = {
  name: 'hip',
  extent: 11,
  height: ({ x, y }) => (Math.abs(x) <= 8 && Math.abs(y) <= 5 ? EAVE + Math.min(5 - Math.abs(y), 8 - Math.abs(x)) * (5 / 12) : null),
  faces: [
    { name: 'north', probe: { x: 0, y: 3 }, pitchX12: 5, downDeg: 90, planAreaM2: 55 },
    { name: 'south', probe: { x: 0, y: -3 }, pitchX12: 5, downDeg: -90, planAreaM2: 55 },
    { name: 'east', probe: { x: 6.5, y: 0 }, pitchX12: 5, downDeg: 0, planAreaM2: 25 },
    { name: 'west', probe: { x: -6.5, y: 0 }, pitchX12: 5, downDeg: 180, planAreaM2: 25 },
  ],
  lines: { ridge: 6, hip: 4 * SQRT(25 + 25 + (5 * (5 / 12)) ** 2), eave: 52 },
  planAreaM2: 160,
};

/**
 * An L-shaped cross gable at 6/12: a main gable X 0..18, Y 0..8 (ridge along X at Y 4) and a wing X 10..18,
 * Y -8..4 (ridge along Y at X 14) meeting it in two valleys. Centred on the house frame's origin.
 */
const L_OFF = { x: 9, y: 0 };
function lHeight({ x, y }: XY): number | null {
  const X = x + L_OFF.x;
  const Y = y + L_OFF.y;
  const main = X >= 0 && X <= 18 && Y >= 0 && Y <= 8 ? (4 - Math.abs(Y - 4)) * 0.5 : null;
  const wing = X >= 10 && X <= 18 && Y >= -8 && Y <= 4 ? (4 - Math.abs(X - 14)) * 0.5 : null;
  if (main === null && wing === null) return null;
  return EAVE + Math.max(main ?? -Infinity, wing ?? -Infinity);
}
const RAKE_4 = SQRT(16 + 4);
export const L_CROSS: Shape = {
  name: 'l-cross-gable',
  extent: 13,
  height: lHeight,
  faces: [
    { name: 'main north', probe: { x: 0 - L_OFF.x + 6, y: 6 }, pitchX12: 6, downDeg: 90, planAreaM2: 72 },
    { name: 'main south', probe: { x: 5 - L_OFF.x, y: 2 }, pitchX12: 6, downDeg: -90, planAreaM2: 48 },
    { name: 'main south east', probe: { x: 17.2 - L_OFF.x, y: 2.8 }, pitchX12: 6, downDeg: -90, planAreaM2: 8 },
    { name: 'wing west', probe: { x: 12 - L_OFF.x, y: -4 }, pitchX12: 6, downDeg: 180, planAreaM2: 40 },
    { name: 'wing east', probe: { x: 16 - L_OFF.x, y: -4 }, pitchX12: 6, downDeg: 0, planAreaM2: 40 },
  ],
  lines: { ridge: 18 + 12, valley: 2 * SQRT(32 + 4), eave: 18 + 10 + 8 + 8, rake: 6 * RAKE_4 },
  planAreaM2: 208,
};

/**
 * A hip roof 18 x 12 m at 6/12 whose top is a flat deck 2 m above the eaves (10 x 4 m). The deck's edges are where it
 * meets the hip faces convex and level: ridges, as a report counts them.
 */
export const HIP_FLAT: Shape = {
  name: 'hip-with-flat',
  extent: 12,
  height: ({ x, y }) =>
    Math.abs(x) <= 9 && Math.abs(y) <= 6 ? EAVE + Math.min(Math.min(6 - Math.abs(y), 9 - Math.abs(x)) * 0.5, 2) : null,
  faces: [
    { name: 'north', probe: { x: 0, y: 4.5 }, pitchX12: 6, downDeg: 90, planAreaM2: 56 },
    { name: 'south', probe: { x: 0, y: -4.5 }, pitchX12: 6, downDeg: -90, planAreaM2: 56 },
    { name: 'east', probe: { x: 7.5, y: 0 }, pitchX12: 6, downDeg: 0, planAreaM2: 32 },
    { name: 'west', probe: { x: -7.5, y: 0 }, pitchX12: 6, downDeg: 180, planAreaM2: 32 },
    { name: 'flat deck', probe: { x: 0, y: 0 }, pitchX12: 0, downDeg: 0, planAreaM2: 40, flat: true },
  ],
  lines: { hip: 4 * SQRT(32 + 4), ridge: 28, eave: 60 },
  planAreaM2: 216,
};

/**
 * A two-storey house 20 x 10 m: the west part (X -10..-1) has its own gable at 8/12 with eaves 3 m above the
 * east part's (X -1..10, gable at 5/12). Where they meet, the upper storey's wall rises out of the lower roof: the upper
 * roof's edge over it is a rake (it climbs, like the gable's), and the lower roof meets the wall up its slope: step
 * flashing.
 */
export const TWO_STOREY: Shape = {
  name: 'two-storey',
  extent: 12,
  height: ({ x, y }) => {
    if (Math.abs(y) > 5 || Math.abs(x) > 10) return null;
    if (x <= -1) return EAVE + 3 + (5 - Math.abs(y)) * (8 / 12);
    return EAVE + (5 - Math.abs(y)) * (5 / 12);
  },
  faces: [
    { name: 'upper north', probe: { x: -5.5, y: 2.5 }, pitchX12: 8, downDeg: 90, planAreaM2: 45 },
    { name: 'upper south', probe: { x: -5.5, y: -2.5 }, pitchX12: 8, downDeg: -90, planAreaM2: 45 },
    { name: 'lower north', probe: { x: 4.5, y: 2.5 }, pitchX12: 5, downDeg: 90, planAreaM2: 55 },
    { name: 'lower south', probe: { x: 4.5, y: -2.5 }, pitchX12: 5, downDeg: -90, planAreaM2: 55 },
  ],
  lines: {
    ridge: 9 + 11,
    eave: 18 + 22,
    rake: 4 * SQRT(25 + (5 * (8 / 12)) ** 2) + 2 * SQRT(25 + (5 * (5 / 12)) ** 2),
    'step-flashing': 2 * SQRT(25 + (5 * (5 / 12)) ** 2),
  },
  planAreaM2: 200,
};

/**
 * A two-storey gable 10 x 8 m at 6/12 (ridge along X, eaves 3 m up) with a porch 10 x 3 m along its south wall under a
 * shed roof at 3/12 falling away from it. The upper roof's south eave runs level over the porch roof: an eave, as a
 * report counts it; the porch roof meets the wall level along it: flashing.
 */
export const PORCH: Shape = {
  name: 'porch',
  extent: 10,
  height: ({ x, y }) => {
    if (Math.abs(x) > 5 || y > 4 || y < -7) return null;
    if (y >= -4) return EAVE + 3 + (4 - Math.abs(y)) * 0.5;
    return EAVE + (y + 7) * (3 / 12);
  },
  faces: [
    { name: 'north', probe: { x: 0, y: 2 }, pitchX12: 6, downDeg: 90, planAreaM2: 40 },
    { name: 'south', probe: { x: 0, y: -2 }, pitchX12: 6, downDeg: -90, planAreaM2: 40 },
    { name: 'porch', probe: { x: 0, y: -5.5 }, pitchX12: 3, downDeg: -90, planAreaM2: 30 },
  ],
  lines: {
    ridge: 10,
    eave: 10 + 10 + 10,
    rake: 4 * SQRT(16 + 4) + 2 * SQRT(9 + 0.75 ** 2),
    flashing: 10,
  },
  planAreaM2: 110,
};

export const SHAPES: readonly Shape[] = [GABLE, HIP, L_CROSS, HIP_FLAT, TWO_STOREY];

/**
 * A terrace of three homes, each 7 x 10 m under a gable at 6/12 with the ridges in line along X; the middle home
 * stands 0.8 m higher than its neighbours, the way terraces step. The mask joins all three. The faces, lines and area
 * are the middle home's (TERRACE_HOME is its footprint, house frame): the home at the point.
 */
export const TERRACE: Shape = {
  name: 'terrace',
  extent: 12,
  height: ({ x, y }) => {
    if (Math.abs(x) > 10.5 || Math.abs(y) > 5) return null;
    return EAVE + (Math.abs(x) <= 3.5 ? 0.8 : 0) + (5 - Math.abs(y)) * 0.5;
  },
  faces: [
    { name: 'north', probe: { x: 0, y: 2.5 }, pitchX12: 6, downDeg: 90, planAreaM2: 35 },
    { name: 'south', probe: { x: 0, y: -2.5 }, pitchX12: 6, downDeg: -90, planAreaM2: 35 },
  ],
  lines: { ridge: 7, eave: 14, rake: 4 * SQRT(25 + 6.25) },
  planAreaM2: 70,
};
export const TERRACE_HOME: readonly XY[] = [
  { x: -3.5, y: -5 },
  { x: 3.5, y: -5 },
  { x: 3.5, y: 5 },
  { x: -3.5, y: 5 },
];

/** A normal deviate (Box-Muller) from a seeded generator. */
function gauss(rng: () => number): number {
  const u = Math.max(1e-12, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The shape as a height map: turned by `turnDeg` (house X axis from east towards north), 0.1 m pixels, `noiseM`
 * Gaussian noise, a 5 x 5 box blur (rounded creases), and `trees` crowns (4 to 6 m above the ground, 1.5 m radius)
 * leaning over the edge.
 */
export function synthesize(
  shape: Shape,
  o: { turnDeg?: number; pixelM?: number; noiseM?: number; trees?: number; seed?: number; overhangAt?: XY } = {},
): SyntheticRoof {
  const s = o.pixelM ?? 0.1;
  const turn = ((o.turnDeg ?? 17) * Math.PI) / 180;
  const rng = rngOf(o.seed ?? 11);
  const half = shape.extent + 5;
  const W = Math.ceil((2 * half) / s);
  const H = W;
  const cx = half;
  const cy = -half;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const toLocal = (p: XY): XY => ({ x: cx + p.x * cos - p.y * sin, y: cy + p.x * sin + p.y * cos });
  const toHouse = (p: XY): XY => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
  };
  const clean = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const h = shape.height(toHouse({ x: (c + 0.5) * s, y: -(r + 0.5) * s }));
      clean[r * W + c] = h ?? 0;
      mask[r * W + c] = h === null ? 0 : 1;
    }
  }
  // Rounded creases and walls: a 5 x 5 box blur.
  const k = 2;
  const blurred = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -k; dr <= k; dr++) {
        for (let dc = -k; dc <= k; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          sum += clean[rr * W + cc]!;
          n++;
        }
      }
      blurred[r * W + c] = sum / n + gauss(rng) * (o.noiseM ?? 0.03);
    }
  }
  // Trees: crowns centred just outside the roof's edge, leaning over it.
  const edge: number[] = [];
  for (let i = 0; i < W * H; i++) {
    const c = i % W;
    const r = (i - c) / W;
    if (mask[i] === 1 && c > 0 && r > 0 && c < W - 1 && r < H - 1 && (mask[i - 1] === 0 || mask[i + 1] === 0 || mask[i - W] === 0 || mask[i + W] === 0)) edge.push(i);
  }
  // Crowns stand just outside the roof (1 m out from an edge pixel, away from the roof's middle) and lean over it.
  let mc = 0;
  let mr = 0;
  let mn = 0;
  for (let i = 0; i < W * H; i++) {
    if (mask[i] !== 1) continue;
    mc += i % W;
    mr += Math.floor(i / W);
    mn++;
  }
  mc /= Math.max(1, mn);
  mr /= Math.max(1, mn);
  for (let t = 0; t < (o.trees ?? 3) && edge.length > 0; t++) {
    const at = edge[Math.floor(rng() * edge.length)]!;
    const ec = at % W;
    const er = (at - ec) / W;
    const len = Math.hypot(ec - mc, er - mr) || 1;
    const tc = Math.round(ec + ((ec - mc) / len) * (1 / s));
    const tr = Math.round(er + ((er - mr) / len) * (1 / s));
    const top = 4 + rng() * 2 + EAVE;
    const rad = 1.5;
    for (let r = Math.max(0, tr - 30); r < Math.min(H, tr + 30); r++) {
      for (let c = Math.max(0, tc - 30); c < Math.min(W, tc + 30); c++) {
        const d = Math.hypot((c - tc) * s, (r - tr) * s);
        if (d > 2 * rad) continue;
        const z = top - (d * d) / (rad * 1.2) + gauss(rng) * 0.2;
        if (z > blurred[r * W + c]!) blurred[r * W + c] = z;
      }
    }
  }
  // An overhanging tree: a broad crown standing over the roof at `overhangAt` (house frame), 3 m above the roof there,
  // with the photo green wherever the crown is above the roof (the mask still says roof: Google's mask often does).
  let green: Uint8Array | null = null;
  if (o.overhangAt !== undefined) {
    green = new Uint8Array(W * H);
    const at = toLocal(o.overhangAt);
    const top = (shape.height(o.overhangAt) ?? EAVE) + 3;
    const rad = 2.6;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        const d = Math.hypot((c + 0.5) * s - at.x, -(r + 0.5) * s - at.y);
        if (d > rad) continue;
        const z = top - (d * d) / (rad * 0.9) + gauss(rng) * 0.25;
        const i = r * W + c;
        if (z > blurred[i]!) {
          blurred[i] = z;
          green[i] = 1;
        }
      }
    }
  }
  const centre = toLocal({ x: 0.3, y: 0.2 });
  return {
    name: shape.name,
    raster: { width: W, height: H, pixelSizeM: s, dsm: blurred, mask, green },
    point: { col: centre.x / s, row: -centre.y / s },
    faces: shape.faces,
    lines: shape.lines,
    planAreaM2: shape.planAreaM2,
    toLocal,
    azimuth: (downDeg) => {
      const a = (downDeg * Math.PI) / 180 + turn;
      const e = Math.cos(a);
      const n = Math.sin(a);
      return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
    },
  };
}
