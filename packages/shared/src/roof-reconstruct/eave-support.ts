// Eave support: does the height map show the roof ending where its outline says it ends?
//
// A real eave drops by metres: the roof is up, the yard beside it is down. Along each outline edge, every STEP_M, the
// support is the median height a little inside the edge minus the median height a little outside it. Where something
// as high as the roof stands outside the edge (a tree crown over the eave, a taller neighbour's wall) there is no drop,
// so the edge cannot be checked from the heights: it is "unverified". On the 54 saved houses an unverified sample
// disagrees with EagleView's outline by more than 0.5 m 41.8% of the time against 13.5% for a supported one (AUC 0.67,
// stable for +-20% on every window and threshold: docs/roof-3d/confidence.md).
//
// Pure, deterministic, never throws: bad input returns { ok: false, reason }. Self-contained (no imports) so the
// outline and canopy tracks can vendor a verbatim copy; only the confidence track edits it.
//
// Coordinates are the reconstruction's raster-local metres: x east from the raster's left edge, y north from its top
// edge (so y <= 0 inside the raster); pixel (col, row) has its centre at ((col + 0.5) s, -(row + 0.5) s).

export type EaveXY = { x: number; y: number };

/** strong: the heights drop 1 m or more across the edge; weak: 0.5-1 m; none: less (unverified). */
export type EaveSupportClass = 'strong' | 'weak' | 'none';

/**
 * Why a sample is unverified: a tree crown beside the edge ('crown'), the outside higher than the inside by more than
 * TALLER_M ('taller-neighbour': a wall or a taller roof), no height data on one side ('data-gap'), or the outside about
 * as high as the inside with nothing else to explain it ('level': a deck, a porch or a low attachment at eave height,
 * or a mask edge in the middle of a roof).
 */
export type EaveUnverifiedReason = 'crown' | 'taller-neighbour' | 'data-gap' | 'level';

export const EAVE_UNVERIFIED_REASONS = ['crown', 'taller-neighbour', 'data-gap', 'level'] as const satisfies readonly EaveUnverifiedReason[];

export type EaveSupportParams = {
  /** Spacing of the samples along the outline, metres (the reference analysis used 0.2). */
  stepM: number;
  /** Inside window, metres from the edge (0.2-0.5: past the eave's rounded lip in a 0.1 m height map, still on the roof). */
  insideM: readonly number[];
  /** Outside window, metres from the edge (0.6-1.0: past any gutter and the DSM's blur, before the next object). */
  outsideM: readonly number[];
  /** A drop of this much or more is strong support, metres (one storey's eave is 2.5 m or more above the ground). */
  strongM: number;
  /** A drop below this is no support, metres (half a metre: well above the DSM's few-centimetre noise and roof ripple). */
  weakM: number;
  /** Outside higher than inside by more than this, metres: a taller neighbour or a wall. */
  tallerM: number;
  /** Side of the square window round a sample in which crown cover is measured, metres. */
  crownWindowM: number;
  /** A sample is canopy-exposed when crown covers at least this share of its window. */
  crownExposedShare: number;
  /** Size limit: more samples than this and the step grows to fit (a 4 km outline at 0.2 m). */
  maxSamples: number;
};

/**
 * The reference analysis's constants (failure-taxonomy section 1.2). +-20% on the windows and threshold moves the AUC
 * between 0.663 and 0.670 and the unverified share between 12.0% and 16.8% on the EagleView houses: not tuned to luck.
 */
export const EAVE_SUPPORT: EaveSupportParams = {
  stepM: 0.2,
  insideM: [0.2, 0.3, 0.4, 0.5],
  outsideM: [0.6, 0.7, 0.8, 0.9, 1.0],
  strongM: 1.0,
  weakM: 0.5,
  tallerM: 0.5,
  crownWindowM: 3,
  crownExposedShare: 0.25,
  maxSamples: 20_000,
};

export type EaveRaster = {
  width: number;
  height: number;
  pixelSizeM: number;
  /** Heights, metres; NaN (or below -1000) where there is no data. Row-major, row 0 at the top. */
  dsm: Float32Array | Float64Array;
};

export type EaveSample = {
  /** Index of the outline edge (from vertex `edge` to vertex `edge + 1`). */
  edge: number;
  x: number;
  y: number;
  /** Inside median minus outside median, metres; null when a side has no height data. */
  dropM: number | null;
  support: EaveSupportClass;
  /** Why it is unverified (null when supported). */
  reason: EaveUnverifiedReason | null;
  /** A crown covers at least crownExposedShare of the window round it (always false without a crown map). */
  canopy: boolean;
};

export type EaveEdge = {
  edge: number;
  lengthM: number;
  samples: number;
  /** Share of the edge's samples in each class. */
  strongShare: number;
  weakShare: number;
  noneShare: number;
  /** The median drop over the edge's samples with data, metres; null when none has data. */
  medianDropM: number | null;
  /** The edge's class: of its median drop; 'none' when no sample has data. */
  support: EaveSupportClass;
  /** Share of the edge's samples exposed to canopy. */
  canopyShare: number;
  /** The most common reason among its unverified samples (ties in EAVE_UNVERIFIED_REASONS order); null when it has none. */
  reason: EaveUnverifiedReason | null;
};

export type EaveSupport = {
  ok: true;
  samples: EaveSample[];
  edges: EaveEdge[];
  /** Outline length, metres. */
  lengthM: number;
  /** Share of outline length (samples) in each class; unverified = none, data gaps included. */
  strongShare: number;
  weakShare: number;
  unverifiedShare: number;
  unverifiedLengthM: number;
  /** Share of outline length exposed to canopy (0 without a crown map). */
  canopyExposure: number;
  /** Unverified length by reason, metres. */
  unverifiedByReasonM: Record<EaveUnverifiedReason, number>;
  /** The step actually used (grows past stepM only on huge outlines). */
  stepM: number;
};

export type EaveSupportFailure = { ok: false; reason: 'bad-outline' | 'bad-raster' | 'bad-crown' };

/** The class of a drop. */
export function supportOf(dropM: number | null, p: Pick<EaveSupportParams, 'strongM' | 'weakM'> = EAVE_SUPPORT): EaveSupportClass {
  if (dropM === null || !Number.isFinite(dropM)) return 'none';
  return dropM >= p.strongM ? 'strong' : dropM >= p.weakM ? 'weak' : 'none';
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 === 1 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

function signedArea(ring: readonly EaveXY[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Summed-area table of a 0/1 map, (w+1) x (h+1). */
export function integral(w: number, h: number, m: Uint8Array): Float64Array {
  const t = new Float64Array((w + 1) * (h + 1));
  for (let r = 0; r < h; r++) {
    let row = 0;
    for (let c = 0; c < w; c++) {
      row += m[r * w + c] !== 0 ? 1 : 0;
      t[(r + 1) * (w + 1) + c + 1] = t[r * (w + 1) + c + 1]! + row;
    }
  }
  return t;
}

/** Share of set pixels in the square of half-side `half` pixels round (c, r), clipped to the grid. */
export function boxShare(t: Float64Array, w: number, h: number, c: number, r: number, half: number): number {
  const c0 = Math.max(0, c - half);
  const r0 = Math.max(0, r - half);
  const c1 = Math.min(w, c + half + 1);
  const r1 = Math.min(h, r + half + 1);
  const n = (c1 - c0) * (r1 - r0);
  if (n <= 0) return 0;
  const W = w + 1;
  return (t[r1 * W + c1]! - t[r0 * W + c1]! - t[r1 * W + c0]! + t[r0 * W + c0]!) / n;
}

/**
 * Eave support of every sample along `outline` (any winding; the outward side is found from its signed area) on the
 * height map, and per edge. `crown` (optional, same grid): 1 where a tree crown is; used for canopy exposure and the
 * 'crown' reason only, never for the drop itself.
 */
export function eaveSupport(
  outline: readonly EaveXY[],
  raster: EaveRaster,
  crown: Uint8Array | null = null,
  params: Partial<EaveSupportParams> = {},
): EaveSupport | EaveSupportFailure {
  const p: EaveSupportParams = { ...EAVE_SUPPORT, ...params };
  const { width: w, height: h, pixelSizeM: s, dsm } = raster;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && s > 0 && Number.isFinite(s)) || dsm.length !== w * h) return { ok: false, reason: 'bad-raster' };
  if (crown !== null && crown.length !== w * h) return { ok: false, reason: 'bad-crown' };
  const ring = outline.filter((q, i) => {
    const prev = outline[(i + outline.length - 1) % outline.length];
    return prev === undefined || prev.x !== q.x || prev.y !== q.y;
  });
  if (ring.length < 3 || !ring.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) return { ok: false, reason: 'bad-outline' };
  const area = signedArea(ring);
  if (!(Math.abs(area) > 1e-9)) return { ok: false, reason: 'bad-outline' };
  let lengthM = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    lengthM += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const step = Math.max(p.stepM, lengthM / Math.max(1, p.maxSamples));
  // Counter-clockwise (positive area, y north): the outward normal of direction (dx, dy) is (dy, -dx).
  const ccw = area > 0;

  const height = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    if (c < 0 || r < 0 || c >= w || r >= h) return NaN;
    const z = dsm[r * w + c]!;
    return Number.isFinite(z) && z > -1000 ? z : NaN;
  };
  const crownT = crown === null ? null : integral(w, h, crown);
  const half = Math.max(0, Math.round(p.crownWindowM / s / 2));

  const samples: EaveSample[] = [];
  const edges: EaveEdge[] = [];
  const byReason: Record<EaveUnverifiedReason, number> = { crown: 0, 'taller-neighbour': 0, 'data-gap': 0, level: 0 };
  let strongN = 0;
  let weakN = 0;
  let noneN = 0;
  let canopyN = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    const dx = (b.x - a.x) / L;
    const dy = (b.y - a.y) / L;
    const nx = ccw ? dy : -dy;
    const ny = ccw ? -dx : dx;
    const counts = { strong: 0, weak: 0, none: 0 };
    const reasons: Record<EaveUnverifiedReason, number> = { crown: 0, 'taller-neighbour': 0, 'data-gap': 0, level: 0 };
    const drops: number[] = [];
    let n = 0;
    let exposed = 0;
    for (let i = 0; ; i++) {
      // Samples at step/2, 3 step/2, ... (0.1, 0.3, ... m), always at least one on an edge.
      const t = step / 2 + i * step;
      if (t >= L && i > 0) break;
      const tt = Math.min(t, L / 2);
      const x = a.x + dx * tt;
      const y = a.y + dy * tt;
      const ins: number[] = [];
      for (const m of p.insideM) {
        const z = height(x - nx * m, y - ny * m);
        if (!Number.isNaN(z)) ins.push(z);
      }
      const outs: number[] = [];
      for (const m of p.outsideM) {
        const z = height(x + nx * m, y + ny * m);
        if (!Number.isNaN(z)) outs.push(z);
      }
      const zin = median(ins);
      const zout = median(outs);
      const dropM = zin === null || zout === null ? null : Math.round((zin - zout) * 1000) / 1000;
      const support = supportOf(dropM, p);
      let canopy = false;
      if (crownT !== null) {
        const c = Math.min(w - 1, Math.max(0, Math.floor(x / s)));
        const r = Math.min(h - 1, Math.max(0, Math.floor(-y / s)));
        canopy = boxShare(crownT, w, h, c, r, half) >= p.crownExposedShare;
      }
      let reason: EaveUnverifiedReason | null = null;
      if (support === 'none') {
        reason = dropM === null ? 'data-gap' : canopy ? 'crown' : dropM <= -p.tallerM ? 'taller-neighbour' : 'level';
        reasons[reason]++;
      }
      counts[support]++;
      if (dropM !== null) drops.push(dropM);
      if (canopy) exposed++;
      n++;
      samples.push({ edge: k, x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, dropM, support, reason, canopy });
    }
    // Each sample stands for L / n of the edge, so shares weigh edges by length.
    const per = L / n;
    strongN += counts.strong * per;
    weakN += counts.weak * per;
    noneN += counts.none * per;
    canopyN += exposed * per;
    for (const r of EAVE_UNVERIFIED_REASONS) byReason[r] += reasons[r] * per;
    const medianDropM = median(drops);
    let top: EaveUnverifiedReason | null = null;
    for (const r of EAVE_UNVERIFIED_REASONS) if (reasons[r] > 0 && (top === null || reasons[r] > reasons[top])) top = r;
    edges.push({
      edge: k,
      lengthM: L,
      samples: n,
      strongShare: counts.strong / n,
      weakShare: counts.weak / n,
      noneShare: counts.none / n,
      medianDropM,
      support: supportOf(medianDropM, p),
      canopyShare: exposed / n,
      reason: top,
    });
  }
  return {
    ok: true,
    samples,
    edges,
    lengthM,
    strongShare: strongN / lengthM,
    weakShare: weakN / lengthM,
    unverifiedShare: noneN / lengthM,
    unverifiedLengthM: noneN,
    canopyExposure: canopyN / lengthM,
    unverifiedByReasonM: byReason,
    stepM: step,
  };
}

/**
 * A crown map from the photo's green and the height map's roughness, the benchmark's canopy definition
 * (docs/roof-3d/benchmark.md): a pixel is tree-like when green and rough (|4z - its four neighbours| >= 0.12 m: a roof
 * plane is smooth, foliage is not); a pixel is crown when at least 10% of the pixels within 0.7 m are tree-like.
 * Colour misses shaded and autumn foliage, so this is a floor: a better map (the canopy track's) can replace it.
 */
export function crownFromGreen(raster: EaveRaster, green: Uint8Array | null | undefined): Uint8Array | null {
  const { width: w, height: h, pixelSizeM: s, dsm } = raster;
  if (green === null || green === undefined || green.length !== w * h || dsm.length !== w * h) return null;
  const tree = new Uint8Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (green[i] === 0) continue;
      const z = dsm[i]!;
      const sum = dsm[i - 1]! + dsm[i + 1]! + dsm[i - w]! + dsm[i + w]!;
      if (Number.isFinite(z) && Number.isFinite(sum) && Math.abs(4 * z - sum) >= 0.12) tree[i] = 1;
    }
  }
  const t = integral(w, h, tree);
  const half = Math.max(1, Math.round(0.7 / s));
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (boxShare(t, w, h, c, r, half) >= 0.1) out[r * w + c] = 1;
  return out;
}
