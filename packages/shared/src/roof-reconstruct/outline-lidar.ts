// Hidden eaves from leaf-off airborne lidar (USGS 3DEP): where a tree crown hides the roof's edge from Google's height
// map, lidar pulses that passed between bare branches still hit the roof and the ground beside it. This step moves the
// outline edges the height map cannot vouch for (eave support 'none', eave-support.ts) to where the lidar's roof ends,
// and leaves everything else to Google: the faces, their planes and pitch, and every edge the heights see.
// Design note, measurements and limits: docs/roof-3d/lidar.md.
//
// Pure and deterministic (no randomness); tens of milliseconds a house (p95 about 0.3 s on a 2 MB QL1 crop). It runs
// between squareOutline and buildTopology (index.ts, step 3b), replaces only edges (never mask pixels), and declines
// with a typed reason (LidarEdgeReason) whenever the lidar cannot be trusted for this house.
//
// 1. Registration onto Google's frame (about a metre apart horizontally, an unknown vertical datum). Under a leaf-on
//    crown Google's heights are the canopy and the lidar's last returns the ground, metres apart, so the fit counts
//    inliers: dz from the mode of the residuals, (dx, dy) maximising last returns within 0.15 m of the height map on
//    smooth pixels (coarse then fine grid), dz again. Declined ('misaligned') at the search limit, when not pinned in
//    both directions, or when roof returns do not lie on Google's faces (median 0.15 m, smooth pixels only).
// 2. Returns are classified: ground (class 2, or a last return within 0.5 m of the ground), roof (a last return 2 m or
//    more up whose neighbourhood is one plane within 0.08 m and no steeper than 24/12: a face Google never fitted
//    counts too), or neither (branches, walls).
// 3. Per outline sample (0.2 m), along the outward normal in a 0.6 m corridor: the run of roof returns that starts
//    inside the edge ends at the first ground bin; the eave is its last roof return plus half the point spacing. No
//    ground bin within 1 m of it: no evidence (the roof may go on where no pulse reached).
// 4. The same detector on the samples the heights DO see gives o = n . delta + b (edgeFrame): the registration's
//    residual shift at the edges and the eave lip; both are taken out of the hidden samples. A large lip or a spread
//    no shift explains means the house changed since the flight ('changed').
// 5. Per edge whose samples are mostly hidden: the median corrected offset of the samples with evidence, when enough
//    agree, moves the edge parallel to itself; corners are rebuilt where the moved lines cross (a jog when they are
//    near parallel or the crossing runs away). Refused when it crosses itself or changes the area by over 30 %.
import { dist, intersectLines, selfIntersects, signedArea, type XY } from './geom.ts';
import { eaveSupport } from './eave-support.ts';
import type { Plane } from './planes.ts';

/**
 * A lidar point cloud round the house, already in the height map's raster-local metres (x east from the raster's left
 * edge, y north from its top edge, so y <= 0). z is in the lidar's own vertical datum: the offset is fitted.
 */
export type LidarCloud = {
  x: Float32Array | Float64Array;
  y: Float32Array | Float64Array;
  z: Float32Array | Float64Array;
  /** Bit 0: last return of its pulse. Bit 1: classified ground (class 2). */
  flags: Uint8Array;
  /** The project was flown leaf-off (USGS work-unit metadata); null when unknown. */
  leafOff: boolean | null;
  /** Whole years between the flight and Google's imagery; null when unknown. */
  ageYears?: number | null;
};

export type LidarEdgeParams = {
  /** Fewer last returns than this per m2 of roof is too sparse to place an edge (QL2 is 2-4, QL1 8+). */
  minRoofDensity: number;
  /** Decline lidar older than this many years (a house changes; the change check is the real guard). */
  maxAgeYears: number;
  /** Decline lidar not known to be leaf-off (a leaf-on canopy hides the eave from lidar too). */
  requireLeafOff: boolean;
  /** Horizontal registration search radius, metres (the truth harness measured a median shift of 1.17 m). */
  searchM: number;
  /** Corridor half-width along the edge round a sample, metres. */
  corridorM: number;
  /** Profile range along the outward normal, metres (inside, outside). */
  insideM: number;
  outsideM: number;
  /** Profile bin, metres. */
  binM: number;
  /** An edge is a candidate when at least this share of its samples is hidden and that is at least minHiddenM. */
  minHiddenShare: number;
  minHiddenM: number;
  /** At least this share of the edge's hidden samples must have lidar evidence. */
  minEvidenceShare: number;
  /** The evidence must agree: median absolute deviation of the offsets at most this, metres. */
  maxSpreadM: number;
  /** Offsets smaller than this are noise and leave the edge alone, metres. */
  minMoveM: number;
  /** Offsets allowed: inward at most maxInM, outward at most maxOutM (a whole hidden wing is v2), metres. */
  maxInM: number;
  maxOutM: number;
  /** Visible-edge bias beyond this means the house changed since the flight (or the frame is wrong), metres. */
  maxBiasM: number;
  /** The new outline may change the area by at most this share. */
  maxAreaChange: number;
  /** Size limit: at most this many points are read (a 70 m QL1 crop is about 150 000). */
  maxPoints: number;
};

/**
 * Constants, each from the physics or the data spec rather than fitted to a house (sensitivity: docs/roof-3d/lidar.md).
 */
export const DEFAULT_LIDAR_EDGE: LidarEdgeParams = {
  minRoofDensity: 4,
  maxAgeYears: 12,
  requireLeafOff: true,
  searchM: 3,
  corridorM: 0.3,
  insideM: 1.5,
  outsideM: 3.5,
  binM: 0.2,
  minHiddenShare: 0.5,
  minHiddenM: 1,
  minEvidenceShare: 0.4,
  maxSpreadM: 0.35,
  minMoveM: 0.15,
  maxInM: 1,
  maxOutM: 3,
  maxBiasM: 0.4,
  maxAreaChange: 0.3,
  maxPoints: 400_000,
};

export const LIDAR_EDGE_REASONS = [
  'no-points',
  'too-many-points',
  'not-leaf-off',
  'too-old',
  'sparse',
  'misaligned',
  'changed',
  'no-hidden-edges',
  'no-evidence',
  'self-intersection',
  'large-change',
  'error',
] as const;
export type LidarEdgeReason = (typeof LIDAR_EDGE_REASONS)[number];

export type LidarEdgeReport = {
  applied: boolean;
  /** Why nothing changed (absent when applied). */
  reason?: LidarEdgeReason;
  /** The registration found (lidar + shift = Google's frame), metres. */
  shift?: { dx: number; dy: number; dz: number; madM: number };
  /** Last returns per m2 on the roof. */
  roofDensity?: number;
  /** The visible-edge bias subtracted, metres (positive: lidar puts eaves outward of Google's visible edges). */
  biasM?: number;
  /** The residual shift measured on the visible edges and taken out of the hidden ones, metres. */
  edgeShift?: { dx: number; dy: number };
  /** With reason 'changed': the visible offsets' spread after the fit, metres. */
  visibleSpreadM?: number;
  /** Candidate (mostly hidden) edges, and the ones moved with their offsets, metres (positive outward). */
  candidates?: number;
  moved?: { edge: number; offsetM: number; lengthM: number }[];
  /** Outline area change, square metres. */
  areaChangeM2?: number;
};

export type LidarEdgeInput = {
  /** The crop's grid and heights (index.ts's crop), and where the crop sits in the whole raster (pixels). */
  g: { w: number; h: number };
  s: number;
  c0: number;
  r0: number;
  /** The whole raster's heights (for the registration and eave support round the crop). */
  raster: { width: number; height: number; dsm: Float32Array };
  /** Face labels on the crop (-1 none) and their planes in crop metres. */
  labels: Int32Array;
  planes: readonly Plane[];
  /** The squared outline in crop metres. */
  outline: readonly XY[];
  cloud: LidarCloud;
  /** Development only: told what each stage found. */
  debug?: (msg: string) => void;
};

/**
 * Room round the crop read for registration and eave support, metres (eave-support reads 1 m outside, the corridor
 * 3.5 m). Wide enough that a house in trees still has open ground and neighbours' roofs to register on: at 4 m, tree
 * houses' windows were mostly canopy and 7 of 54 dev houses failed to register.
 */
const WINDOW_M = 10;
/** Height-map roughness above which a pixel is not used for registration (foliage; the estimator's tree test). */
const ROUGH_M = 0.12;
/** A return within this of the height map is an inlier of the registration, metres (DSM noise plus QL1/QL2 vertical). */
const REG_INLIER_M = 0.15;
/** Vertical datum search: +-range in bins, metres. */
const REG_DZ_RANGE_M = 60;
const REG_DZ_BIN_M = 0.1;
/** The inliers must fall by at least this share REG_PIN_STEP_M away from the best shift, in x and in y. */
const REG_PIN_STEP_M = 0.5;
const REG_PIN_DROP = 0.001;
/** Roof returns must sit on their planes after registration: median absolute residual at most this, metres. */
const REG_MAD_M = 0.15;
/** Points used for the coarse registration search (deterministic stride). */
const REG_COARSE_POINTS = 8000;
const REG_FINE_POINTS = 30000;
/** Empty bins tolerated inside the roof run (pulses lost under a branch), as a length, metres. */
const MAX_GAP_M = 0.6;
/** The ground bin that ends the run must come within this of the last roof return, metres. */
const END_WITHIN_M = 1;
/** Visible samples with evidence needed to measure the bias; fewer and it is taken as 0. */
const MIN_BIAS_SAMPLES = 20;

export type Win = { c0: number; r0: number; w: number; h: number; dsm: Float32Array };

/** Hidden edges moved onto the lidar's eaves, or the outline unchanged with the reason. Never throws. */
export function lidarHiddenEdges(input: LidarEdgeInput, prm: LidarEdgeParams = DEFAULT_LIDAR_EDGE): { outline: XY[]; report: LidarEdgeReport } {
  try {
    return run(input, prm);
  } catch {
    return { outline: input.outline.slice(), report: { applied: false, reason: 'error' } };
  }
}

function run(input: LidarEdgeInput, prm: LidarEdgeParams): { outline: XY[]; report: LidarEdgeReport } {
  const { g, s, c0, r0, raster, labels, planes, cloud } = input;
  // Repeated corners dropped (eave-support.ts numbers its edges on the ring without them).
  const outline = input.outline.filter((q, i) => {
    const p = input.outline[(i + input.outline.length - 1) % input.outline.length]!;
    return q.x !== p.x || q.y !== p.y;
  });
  const keep = (reason: LidarEdgeReason, extra: Partial<LidarEdgeReport> = {}) => ({ outline: outline.slice(), report: { applied: false, reason, ...extra } });
  const n = cloud.x.length;
  if (n === 0 || cloud.y.length !== n || cloud.z.length !== n || cloud.flags.length !== n) return keep('no-points');
  if (n > prm.maxPoints) return keep('too-many-points');
  if (prm.requireLeafOff && cloud.leafOff !== true) return keep('not-leaf-off');
  if (cloud.ageYears != null && cloud.ageYears > prm.maxAgeYears) return keep('too-old');
  if (outline.length < 3) return keep('no-hidden-edges');

  // The window round the crop, in whole-raster pixels.
  const m = Math.ceil(WINDOW_M / s);
  const wc0 = Math.max(0, c0 - m);
  const wr0 = Math.max(0, r0 - m);
  const wc1 = Math.min(raster.width - 1, c0 + g.w - 1 + m);
  const wr1 = Math.min(raster.height - 1, r0 + g.h - 1 + m);
  const win: Win = { c0: wc0, r0: wr0, w: wc1 - wc0 + 1, h: wr1 - wr0 + 1, dsm: new Float32Array((wc1 - wc0 + 1) * (wr1 - wr0 + 1)) };
  for (let r = 0; r < win.h; r++) {
    for (let c = 0; c < win.w; c++) {
      const z = raster.dsm[(r + wr0) * raster.width + c + wc0]!;
      win.dsm[r * win.w + c] = Number.isFinite(z) && z > -1000 && z < 10000 ? z : Number.NaN;
    }
  }
  // Crop metres -> window metres.
  const ox = (c0 - wc0) * s;
  const oy = -(r0 - wr0) * s;

  // Points inside the window (window metres), in their given order (deterministic).
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const pf: number[] = [];
  const wx = win.w * s;
  const wy = win.h * s;
  for (let i = 0; i < n; i++) {
    const x = cloud.x[i]! - wc0 * s;
    const y = cloud.y[i]! + wr0 * s;
    const z = cloud.z[i]!;
    if (!(x >= -prm.searchM && x < wx + prm.searchM && y <= prm.searchM && y > -wy - prm.searchM && Number.isFinite(z))) continue;
    px.push(x);
    py.push(y);
    pz.push(z);
    pf.push(cloud.flags[i]!);
  }
  if (px.length < 50) return keep('no-points');

  // 1. Registration.
  const smooth = smoothMap(win, s);
  const reg = register(win, s, smooth, px, py, pz, pf, prm.searchM, input.debug);
  if (reg === null) return keep('misaligned');
  const shift = { dx: round(reg.dx, 3), dy: round(reg.dy, 3), dz: round(reg.dz, 3), madM: 0 };

  // Registered points in crop metres, bucketed on a 0.5 m grid for the corridor queries.
  const P = px.length;
  const qx = new Float64Array(P);
  const qy = new Float64Array(P);
  const qz = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    qx[i] = px[i]! + reg.dx - ox;
    qy[i] = py[i]! + reg.dy - oy;
    qz[i] = pz[i]! + reg.dz;
  }
  const grid = bucket(qx, qy, 0.5);
  // Roof and ground returns (classify): roof is any smooth raised surface, so a face Google never fitted (a wing under
  // a crown) counts too; the faces' planes are used only for the registration check below.

  // Roof density and on-plane check: last returns over labelled crop pixels.
  let roofPx = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= 0) roofPx++;
  let roofPts = 0;
  const resid: number[] = [];
  for (let i = 0; i < P; i++) {
    if ((pf[i]! & 1) === 0) continue;
    const c = Math.floor(qx[i]! / s);
    const r = Math.floor(-qy[i]! / s);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) continue;
    const k = labels[r * g.w + c]!;
    if (k < 0) continue;
    roofPts++;
    // Only where the height map is smooth: under a crown Google's faces can be fitted to the canopy, not the roof.
    if (smooth[(r + r0 - wr0) * win.w + c + c0 - wc0] !== 1) continue;
    const p = planes[k]!;
    resid.push(Math.abs(qz[i]! - (p.a * qx[i]! + p.b * qy[i]! + p.c)));
  }
  const roofDensity = roofPx > 0 ? roofPts / (roofPx * s * s) : 0;
  const madM = resid.length > 0 ? median(resid) : Infinity;
  shift.madM = round(madM, 3);
  input.debug?.(`lidar roof: ${roofPts} last returns on ${(roofPx * s * s).toFixed(1)} m2, MAD ${madM.toFixed(3)} m`);
  const base = { shift, roofDensity: round(roofDensity, 2) };
  if (roofDensity < prm.minRoofDensity) return keep('sparse', base);
  if (!(madM <= REG_MAD_M)) return keep('misaligned', base);
  const halfSpacing = Math.min(0.15, 0.5 / Math.sqrt(roofDensity));
  const cls = classify(qx, qy, qz, pf, grid, roofDensity);

  // 2. Eave support of the outline on the window (eave-support.ts needs the outside of the edge too).
  // eaveSupport (c606b7a4) places every sample past an edge's midpoint AT the midpoint (tt = min(t, L / 2)), so the
  // outline goes in as pieces of at most one step, each measured once at its middle, and the pieces map back to edges.
  const dense = densify(outline, SAMPLE_STEP_M);
  const ring = dense.pts.map((p) => ({ x: p.x + ox, y: p.y + oy }));
  const sup = eaveSupport(ring, { width: win.w, height: win.h, pixelSizeM: s, dsm: win.dsm }, null, { stepM: SAMPLE_STEP_M });
  if (!sup.ok) return keep('no-hidden-edges', base);
  const ccw = signedArea(outline) > 0;
  const E = outline.length;
  const hiddenN = new Array<number>(E).fill(0);
  const totalN = new Array<number>(E).fill(0);
  const offsets: number[][] = Array.from({ length: E }, () => []);
  const hiddenWithEvidence = new Array<number>(E).fill(0);
  const visibleOffsets: number[] = [];
  const visibleNormals: XY[] = [];
  const hiddenNormals: XY[] = [];
  const profile = profiler(qx, qy, cls, grid, prm, halfSpacing);
  for (const q of sup.samples) {
    const k = dense.edgeOf[q.edge] ?? -1;
    if (k < 0 || k >= E) continue;
    const a = outline[k]!;
    const b = outline[(k + 1) % E]!;
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    const nrm = ccw ? { x: t.y, y: -t.x } : { x: -t.y, y: t.x };
    const p = { x: q.x - ox, y: q.y - oy };
    totalN[k]!++;
    // Every unverified sample, a crown taller than the roof ('taller-neighbour') included: a wall or a taller roof
    // beside the edge gives no ground bin, so no evidence, so no move.
    const hidden = q.support === 'none';
    if (q.support === 'strong') {
      const d = profile(p, t, nrm);
      if (d !== null) {
        visibleOffsets.push(d);
        visibleNormals.push(nrm);
      }
      continue;
    }
    if (!hidden) continue;
    hiddenN[k]!++;
    const d = profile(p, t, nrm);
    if (d !== null) {
      offsets[k]!.push(d);
      hiddenWithEvidence[k]!++;
      if (offsets[k]!.length === 1) hiddenNormals[k] = nrm;
    }
  }

  if (input.debug !== undefined) {
    for (let k = 0; k < E; k++) input.debug(`lidar edge ${k}: ${dist(outline[k]!, outline[(k + 1) % E]!).toFixed(1)} m, ${totalN[k]} samples, ${hiddenN[k]} hidden, ${hiddenWithEvidence[k]} with evidence, offsets ${offsets[k]!.map((d) => d.toFixed(2)).join(' ')}`);
    input.debug(`lidar visible samples with evidence: ${visibleOffsets.length}, median ${median(visibleOffsets).toFixed(2)}`);
  }
  // 3. Bias on the visible edges; a large one means the roof is not the one the lidar saw.
  // The visible edges' offsets as o = n . delta + b: delta, the registration's residual shift where it matters (at the
  // edges; the height-map fit is weakly pinned along a lone gable's ridge), b, the eave lip (the height map's blurred
  // edge against the lidar's last roof return). With visible edges in one direction only, b alone.
  const fit = edgeFrame(visibleNormals, visibleOffsets);
  const bias = fit.b;
  const withBias = { ...base, biasM: round(bias, 3), ...(fit.delta !== null ? { edgeShift: { dx: round(fit.delta.x, 3), dy: round(fit.delta.y, 3) } } : {}) };
  input.debug?.(`lidar edge frame: b ${bias.toFixed(2)} delta ${fit.delta === null ? '-' : `${fit.delta.x.toFixed(2)},${fit.delta.y.toFixed(2)}`} from ${visibleOffsets.length} samples`);
  // A house that changed since the flight shows as visible edges the lidar puts elsewhere, not as one shift of them all
  // (a shift is the registration's, taken out): a large lip bias, or visible offsets the fit cannot explain.
  if (fit.delta !== null && Math.hypot(fit.delta.x, fit.delta.y) > MAX_EDGE_SHIFT_M) return keep('misaligned', withBias);
  if (Math.abs(bias) > prm.maxBiasM || fit.spread > prm.maxBiasM) return keep('changed', { ...withBias, visibleSpreadM: round(fit.spread, 3) });
  const correction = (nrm: XY) => bias + (fit.delta === null ? 0 : nrm.x * fit.delta.x + nrm.y * fit.delta.y);

  // 4. Edges to move.
  const step = SAMPLE_STEP_M;
  const move = new Array<number>(E).fill(0);
  let candidates = 0;
  const moved: { edge: number; offsetM: number; lengthM: number }[] = [];
  for (let k = 0; k < E; k++) {
    if (totalN[k] === 0) continue;
    const share = hiddenN[k]! / totalN[k]!;
    if (share < prm.minHiddenShare || hiddenN[k]! * step < prm.minHiddenM) continue;
    candidates++;
    if (hiddenWithEvidence[k]! < prm.minEvidenceShare * hiddenN[k]!) continue;
    const corr = correction(hiddenNormals[k] ?? { x: 0, y: 0 });
    const o = offsets[k]!.map((d) => d - corr);
    const med = median(o);
    const spread = median(o.map((d) => Math.abs(d - med)));
    if (spread > prm.maxSpreadM || med < -prm.maxInM || med > prm.maxOutM || Math.abs(med) < prm.minMoveM) continue;
    move[k] = med;
    moved.push({ edge: k, offsetM: round(med, 3), lengthM: round(dist(outline[k]!, outline[(k + 1) % E]!), 2) });
  }
  const report: LidarEdgeReport = { applied: false, ...withBias, candidates, moved };
  if (candidates === 0) return { outline: outline.slice(), report: { ...report, reason: 'no-hidden-edges' } };
  if (moved.length === 0) return { outline: outline.slice(), report: { ...report, reason: 'no-evidence' } };

  const next = offsetEdges(outline, move, ccw);
  if (next === null || next.length < 3 || selfIntersects(next)) return { outline: outline.slice(), report: { ...report, reason: 'self-intersection' } };
  const a0 = Math.abs(signedArea(outline));
  const a1 = Math.abs(signedArea(next));
  if (!(a0 > 0) || Math.abs(a1 - a0) > prm.maxAreaChange * a0) return { outline: outline.slice(), report: { ...report, reason: 'large-change' } };
  return { outline: next, report: { ...report, applied: true, areaChangeM2: round(a1 - a0, 2) } };
}

/** 1 where the height map is smooth (a plane or flat ground, not foliage) and has data, on the window. */
export function smoothMap(win: Win, s: number): Uint8Array {
  const out = new Uint8Array(win.w * win.h);
  const lim = ROUGH_M * Math.max(1, s / 0.1);
  for (let r = 1; r < win.h - 1; r++) {
    for (let c = 1; c < win.w - 1; c++) {
      const i = r * win.w + c;
      const z = win.dsm[i]!;
      const lap = Math.abs(4 * z - win.dsm[i - 1]! - win.dsm[i + 1]! - win.dsm[i - win.w]! - win.dsm[i + win.w]!);
      if (lap < lim) out[i] = 1;
    }
  }
  return out;
}

/**
 * The shift putting the lidar onto the height map. Under a leaf-on crown Google's heights are the canopy and the lidar's
 * last returns the ground beneath it, metres apart, so the fit counts inliers (returns within REG_INLIER_M of the height
 * map) instead of averaging residuals: dz from the mode of the residuals, then (dx, dy) maximising the inliers on a
 * coarse then a fine grid, then dz again from the inliers. Null when the best shift is at the search limit or the inlier
 * count does not fall away from it in x and in y (a frame the data do not pin).
 */
export function register(win: Win, s: number, smooth: Uint8Array, px: number[], py: number[], pz: number[], pf: number[], searchM: number, debug?: (msg: string) => void) {
  const at = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    if (c < 0 || r < 0 || c >= win.w || r >= win.h) return -1;
    const i = r * win.w + c;
    return smooth[i] === 1 ? i : -1;
  };
  // Last returns only (a branch hit is rarely its pulse's last return).
  const idx: number[] = [];
  for (let i = 0; i < px.length; i++) if ((pf[i]! & 1) === 1) idx.push(i);
  if (idx.length < 200) return null;
  const sample = (want: number) => {
    const stride = Math.max(1, Math.floor(idx.length / want));
    const out: number[] = [];
    for (let j = 0; j < idx.length; j += stride) out.push(idx[j]!);
    return out;
  };
  const fine = sample(REG_FINE_POINTS);
  const coarse = sample(REG_COARSE_POINTS);
  // dz: the mode of the residuals (a vertical datum can differ by tens of metres; the geoid alone is up to 50 m).
  const bins = new Int32Array(Math.round((2 * REG_DZ_RANGE_M) / REG_DZ_BIN_M));
  for (const i of fine) {
    const k = at(px[i]!, py[i]!);
    if (k < 0) continue;
    const b = Math.floor((win.dsm[k]! - pz[i]! + REG_DZ_RANGE_M) / REG_DZ_BIN_M);
    if (b >= 0 && b < bins.length) bins[b]!++;
  }
  let mode = -1;
  for (let b = 0; b < bins.length; b++) if (mode < 0 || bins[b]! > bins[mode]!) mode = b;
  if (mode < 0 || bins[mode]! < 20) return null;
  let dz = (mode + 0.5) * REG_DZ_BIN_M - REG_DZ_RANGE_M;
  const inliers = (dx: number, dy: number, dzv: number, ids: readonly number[]): number => {
    let cnt = 0;
    for (const i of ids) {
      const k = at(px[i]! + dx, py[i]! + dy);
      if (k >= 0 && Math.abs(win.dsm[k]! - pz[i]! - dzv) <= REG_INLIER_M) cnt++;
    }
    return cnt;
  };
  const refitDz = (dx: number, dy: number, dzv: number): number => {
    const d: number[] = [];
    for (const i of fine) {
      const k = at(px[i]! + dx, py[i]! + dy);
      if (k < 0) continue;
      const r = win.dsm[k]! - pz[i]!;
      if (Math.abs(r - dzv) <= 2 * REG_INLIER_M) d.push(r);
    }
    return d.length >= 50 ? median(d) : dzv;
  };
  let best = { dx: 0, dy: 0, n: -1 };
  const st = 0.25;
  const steps = Math.round(searchM / st);
  for (let iy = -steps; iy <= steps; iy++) {
    for (let ix = -steps; ix <= steps; ix++) {
      const n = inliers(ix * st, iy * st, dz, coarse);
      if (n > best.n) best = { dx: ix * st, dy: iy * st, n };
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    dz = refitDz(best.dx, best.dy, dz);
    const cx = best.dx;
    const cy = best.dy;
    best = { dx: cx, dy: cy, n: inliers(cx, cy, dz, fine) };
    for (let iy = -6; iy <= 6; iy++) {
      for (let ix = -6; ix <= 6; ix++) {
        const dx = cx + ix * 0.05;
        const dy = cy + iy * 0.05;
        const n = inliers(dx, dy, dz, fine);
        if (n > best.n) best = { dx, dy, n };
      }
    }
  }
  dz = refitDz(best.dx, best.dy, dz);
  best.n = inliers(best.dx, best.dy, dz, fine);
  debug?.(`lidar registration: dx ${best.dx.toFixed(2)} dy ${best.dy.toFixed(2)} dz ${dz.toFixed(2)}, ${best.n} inliers of ${fine.length} last returns`);
  if (best.n < 100 || Math.abs(best.dx) > searchM - st || Math.abs(best.dy) > searchM - st) return null;
  // Pinned in both directions: the inliers fall away from the best shift along x and along y.
  const drop = (ddx: number, ddy: number) => 1 - Math.max(inliers(best.dx + ddx, best.dy + ddy, dz, fine), inliers(best.dx - ddx, best.dy - ddy, dz, fine)) / best.n;
  const px0 = drop(REG_PIN_STEP_M, 0);
  const py0 = drop(0, REG_PIN_STEP_M);
  debug?.(`lidar registration pinned by ${(100 * px0).toFixed(1)}% (x) ${(100 * py0).toFixed(1)}% (y)`);
  if (!(px0 >= REG_PIN_DROP && py0 >= REG_PIN_DROP)) return null;
  return { dx: best.dx, dy: best.dy, dz };
}

/** Point indices on a square grid of `cell` metres (keys col,row). */
export function bucket(x: Float64Array, y: Float64Array, cell: number): { cell: number; map: Map<number, number[]> } {
  const map = new Map<number, number[]>();
  for (let i = 0; i < x.length; i++) {
    const key = cellKey(Math.floor(x[i]! / cell), Math.floor(y[i]! / cell));
    let l = map.get(key);
    if (l === undefined) map.set(key, (l = []));
    l.push(i);
  }
  return { cell, map };
}
const cellKey = (c: number, r: number) => (c + 50_000) * 100_000 + (r + 50_000);

/**
 * Least squares of o = n . delta + b over visible samples (robust: one pass, then again without residuals over
 * EDGE_FRAME_OUTLIER_M). delta null when the normals do not span two directions (EDGE_FRAME_MIN_EIG) or there are too
 * few samples; then b is their median (0 under MIN_BIAS_SAMPLES).
 */
function edgeFrame(normals: readonly XY[], offsets: readonly number[]): { b: number; delta: XY | null; spread: number } {
  if (offsets.length < MIN_BIAS_SAMPLES) return { b: 0, delta: null, spread: 0 };
  // The spread left: median absolute residual of the visible offsets after the fit.
  const spreadOf = (f: { b: number; delta: XY | null }) =>
    median(offsets.map((o, i) => Math.abs(o - f.b - (f.delta === null ? 0 : normals[i]!.x * f.delta.x + normals[i]!.y * f.delta.y))));
  const solve = (use: (i: number) => boolean): { b: number; delta: XY } | null => {
    // Normal equations for [dx, dy, b].
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const v = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (!use(i)) continue;
      const r = [normals[i]!.x, normals[i]!.y, 1];
      for (let a = 0; a < 3; a++) {
        v[a]! += r[a]! * offsets[i]!;
        for (let c = 0; c < 3; c++) A[a * 3 + c]! += r[a]! * r[c]!;
      }
      n++;
    }
    if (n < MIN_BIAS_SAMPLES) return null;
    // The normals' spread: the smaller eigenvalue of their 2 x 2 scatter (centred), per sample.
    const mx = A[2]! / n;
    const my = A[5]! / n;
    const sxx = A[0]! / n - mx * mx;
    const syy = A[4]! / n - my * my;
    const sxy = A[1]! / n - mx * my;
    const tr = sxx + syy;
    const minEig = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
    if (minEig < EDGE_FRAME_MIN_EIG) return null;
    const x = solve3(A, v);
    return x === null ? null : { delta: { x: x[0]!, y: x[1]! }, b: x[2]! };
  };
  const first = solve(() => true);
  if (first === null) {
    const b = median(offsets);
    return { b, delta: null, spread: spreadOf({ b, delta: null }) };
  }
  const again = solve((i) => Math.abs(offsets[i]! - (normals[i]!.x * first.delta.x + normals[i]!.y * first.delta.y + first.b)) <= EDGE_FRAME_OUTLIER_M) ?? first;
  return { ...again, spread: spreadOf(again) };
}

/** A 3 x 3 system by Cramer's rule; null when singular. */
function solve3(A: readonly number[], v: readonly number[]): number[] | null {
  const det = (m: readonly number[]) => m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) - m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) + m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  const d = det(A);
  if (Math.abs(d) < 1e-12) return null;
  return [0, 1, 2].map((k) => {
    const m = A.slice();
    for (let r = 0; r < 3; r++) m[r * 3 + k] = v[r]!;
    return det(m) / d;
  });
}
/** Visible normals must spread at least this much (smaller eigenvalue; 0.25 for edges in two perpendicular directions in equal measure). */
const EDGE_FRAME_MIN_EIG = 0.05;
/** A rebuilt corner may move at most this many times the larger of its two edges' moves (else a jog). */
const CORNER_RUN = 1.5;
/** Outline samples every this many metres (eave-support.ts's step). */
const SAMPLE_STEP_M = 0.2;

/** The ring cut into pieces of at most `step` metres (collinear corners added), and each piece's original edge. */
export function densify(ring: readonly XY[], step: number): { pts: XY[]; edgeOf: number[] } {
  const pts: XY[] = [];
  const edgeOf: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const m = Math.max(1, Math.ceil(dist(a, b) / step - 1e-9));
    for (let i = 0; i < m; i++) {
      pts.push({ x: a.x + ((b.x - a.x) * i) / m, y: a.y + ((b.y - a.y) * i) / m });
      edgeOf.push(k);
    }
  }
  return { pts, edgeOf };
}
const EDGE_FRAME_OUTLIER_M = 0.5;
/** The residual shift the visible edges may correct, metres (the registration's error budget; more is a wrong frame). */
const MAX_EDGE_SHIFT_M = 1;

export const ROOF = 1;
export const GROUND = 2;

/**
 * Each registered return as roof (ROOF), ground (GROUND) or neither (0: a branch, a wall, a fence). Ground: classified
 * ground (class 2) or a last return within GROUND_HAG_M of the ground. Roof: a last return at least ROOF_HAG_M above the
 * ground whose neighbours (last returns within a radius holding about ROOF_NEIGHBOURS at this density) lie on one plane
 * within ROOF_RMS_M and no steeper than MAX_ROOF_SLOPE: a roof is smooth, bare branches are not.
 */
export function classify(qx: Float64Array, qy: Float64Array, qz: Float64Array, pf: number[], grid: { cell: number; map: Map<number, number[]> }, density: number): Uint8Array {
  const n = qx.length;
  const out = new Uint8Array(n);
  // The ground: median of ground returns per GROUND_CELL_M cell, looked up in the nearest cells that have any.
  const gmap = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if ((pf[i]! & 2) !== 2) continue;
    const key = cellKey(Math.floor(qx[i]! / GROUND_CELL_M), Math.floor(qy[i]! / GROUND_CELL_M));
    let l = gmap.get(key);
    if (l === undefined) gmap.set(key, (l = []));
    l.push(qz[i]!);
  }
  const gmed = new Map<number, number>();
  for (const [k, l] of gmap) gmed.set(k, median(l));
  const groundAt = (x: number, y: number): number => {
    const c = Math.floor(x / GROUND_CELL_M);
    const r = Math.floor(y / GROUND_CELL_M);
    for (let ring = 0; ring <= GROUND_SEARCH_CELLS; ring++) {
      const zs: number[] = [];
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== ring) continue;
          const z = gmed.get(cellKey(c + dc, r + dr));
          if (z !== undefined) zs.push(z);
        }
      }
      if (zs.length > 0) return median(zs);
    }
    return Number.NaN;
  };
  const radius = Math.max(ROOF_MIN_RADIUS_M, Math.sqrt(ROOF_NEIGHBOURS / (Math.PI * Math.max(density, 0.5))));
  const r2 = radius * radius;
  const reach = Math.ceil(radius / grid.cell);
  for (let i = 0; i < n; i++) {
    if ((pf[i]! & 1) === 0) continue;
    const ground = groundAt(qx[i]!, qy[i]!);
    if (!Number.isFinite(ground)) continue;
    const hag = qz[i]! - ground;
    if ((pf[i]! & 2) === 2 || hag < GROUND_HAG_M) {
      out[i] = GROUND;
      continue;
    }
    if (hag < ROOF_HAG_M) continue;
    // Plane through the neighbours (centred on the point), least squares.
    const c0 = Math.floor(qx[i]! / grid.cell);
    const r0 = Math.floor(qy[i]! / grid.cell);
    let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0, sx = 0, sy = 0, m = 0;
    const nb: number[] = [];
    for (let r = r0 - reach; r <= r0 + reach; r++) {
      for (let c = c0 - reach; c <= c0 + reach; c++) {
        const l = grid.map.get(cellKey(c, r));
        if (l === undefined) continue;
        for (const j of l) {
          if ((pf[j]! & 1) === 0) continue;
          const dx = qx[j]! - qx[i]!;
          const dy = qy[j]! - qy[i]!;
          if (dx * dx + dy * dy > r2) continue;
          const dz = qz[j]! - qz[i]!;
          // Returns far below or above are the ground or branches beside the roof, not the roof's own neighbours.
          if (Math.abs(dz) > ROOF_NEIGHBOUR_DZ_M) continue;
          sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz; sz += dz; sx += dx; sy += dy; m++;
          nb.push(j);
        }
      }
    }
    if (m < ROOF_MIN_NEIGHBOURS) continue;
    // Centre the sums.
    const mx = sx / m, my = sy / m, mz = sz / m;
    const cxx = sxx / m - mx * mx, cxy = sxy / m - mx * my, cyy = syy / m - my * my, cxz = sxz / m - mx * mz, cyz = syz / m - my * mz;
    const det = cxx * cyy - cxy * cxy;
    if (!(det > 1e-9)) continue;
    const a = (cxz * cyy - cyz * cxy) / det;
    const b = (cyz * cxx - cxz * cxy) / det;
    if (Math.hypot(a, b) > MAX_ROOF_SLOPE) continue;
    let ss = 0;
    for (const j of nb) {
      const e = qz[j]! - qz[i]! - mz - a * (qx[j]! - qx[i]! - mx) - b * (qy[j]! - qy[i]! - my);
      ss += e * e;
    }
    // Most of the neighbourhood must be in it: a branch with two roof returns under it is not the roof.
    if (Math.sqrt(ss / m) <= ROOF_RMS_M) out[i] = ROOF;
  }
  return out;
}
/** Ground cell for the ground height, metres, and how many cells away a ground cell is looked for. */
const GROUND_CELL_M = 2;
const GROUND_SEARCH_CELLS = 3;
/** A last return this close to the ground is ground, metres. */
const GROUND_HAG_M = 0.5;
/** A roof is at least this high above the ground, metres (a carport or porch roof is 2.2 m and more). */
const ROOF_HAG_M = 2;
/** Roof neighbourhood: about this many returns, at least this radius, these many at least, this flat. */
const ROOF_NEIGHBOURS = 10;
const ROOF_MIN_RADIUS_M = 0.6;
const ROOF_MIN_NEIGHBOURS = 5;
const ROOF_NEIGHBOUR_DZ_M = 1.5;
const ROOF_RMS_M = 0.08;
/** Steeper than 24/12 is a wall or a branch, not a roof (the reconstruction's own ceiling). */
const MAX_ROOF_SLOPE = 2;

/**
 * The lidar eave's offset from a sample along the outward normal (metres, positive outward), or null without evidence:
 * the run of roof returns that starts inside the edge, continues over short gaps, and ends at the first ground bin
 * within END_WITHIN_M of the last roof return; the eave is that last roof return plus half the point spacing.
 */
function profiler(
  qx: Float64Array,
  qy: Float64Array,
  cls: Uint8Array,
  grid: { cell: number; map: Map<number, number[]> },
  prm: LidarEdgeParams,
  halfSpacing: number,
) {
  const nb = Math.round((prm.insideM + prm.outsideM) / prm.binM);
  return (p: XY, t: XY, nrm: XY): number | null => {
    const on = new Array<number>(nb).fill(0);
    const low = new Array<number>(nb).fill(0);
    const maxOn = new Array<number>(nb).fill(-Infinity);
    const reach = Math.max(prm.insideM, prm.outsideM) + prm.corridorM;
    const c0 = Math.floor((p.x - reach) / grid.cell);
    const c1 = Math.floor((p.x + reach) / grid.cell);
    const r0 = Math.floor((p.y - reach) / grid.cell);
    const r1 = Math.floor((p.y + reach) / grid.cell);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const l = grid.map.get(cellKey(c, r));
        if (l === undefined) continue;
        for (const i of l) {
          const k = cls[i]!;
          if (k === 0) continue;
          const vx = qx[i]! - p.x;
          const vy = qy[i]! - p.y;
          if (Math.abs(vx * t.x + vy * t.y) > prm.corridorM) continue;
          const d = vx * nrm.x + vy * nrm.y;
          if (d < -prm.insideM || d >= prm.outsideM) continue;
          const b = Math.floor((d + prm.insideM) / prm.binM);
          if (k === ROOF) {
            on[b]!++;
            if (d > maxOn[b]!) maxOn[b] = d;
          } else low[b]!++;
        }
      }
    }
    // The run must start on the roof: roof returns inside the edge and no ground there.
    const inBins = Math.round(prm.insideM / prm.binM);
    let inOn = 0;
    let inLow = 0;
    for (let b = 0; b < inBins; b++) {
      inOn += on[b]!;
      inLow += low[b]!;
    }
    if (inOn < 2 || inLow > inOn) return null;
    // Walk outward: roof bins and short empty gaps continue the run; the first ground bin ends it.
    const maxGap = Math.round(MAX_GAP_M / prm.binM);
    let lastOn = -Infinity;
    let gap = 0;
    for (let b = 0; b < nb; b++) {
      if (on[b]! > 0 && on[b]! >= low[b]!) {
        lastOn = Math.max(lastOn, maxOn[b]!);
        gap = 0;
        continue;
      }
      if (low[b]! > 0) {
        if (b < inBins - 2) {
          // Ground well inside the edge (a courtyard, a mask over the yard): this sample's roof ends inside.
          lastOn = -Infinity;
          continue;
        }
        if (!Number.isFinite(lastOn)) return null;
        const binStart = b * prm.binM - prm.insideM;
        if (binStart - lastOn > END_WITHIN_M) return null;
        return lastOn + halfSpacing;
      }
      gap++;
      if (gap > maxGap && Number.isFinite(lastOn) && b >= inBins) return null;
    }
    return null;
  };
}

/**
 * The ring with edge k moved `move[k]` metres along its outward normal; corners rebuilt where neighbouring (moved)
 * edges cross, or a jog between them when they are near parallel or the crossing would run away along an edge.
 */
export function offsetEdges(ring: readonly XY[], move: readonly number[], ccw: boolean): XY[] | null {
  const E = ring.length;
  const lines = ring.map((a, k) => {
    const b = ring[(k + 1) % E]!;
    const len = dist(a, b);
    const d = len > 1e-12 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
    const nrm = ccw ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x };
    const o = move[k] ?? 0;
    return { p: { x: a.x + o * nrm.x, y: a.y + o * nrm.y }, d, nrm, o };
  });
  const out: XY[] = [];
  for (let k = 0; k < E; k++) {
    const prev = lines[(k + E - 1) % E]!;
    const cur = lines[k]!;
    const v = ring[k]!;
    if (prev.o === 0 && cur.o === 0) {
      out.push({ x: v.x, y: v.y });
      continue;
    }
    const sin = Math.abs(prev.d.x * cur.d.y - prev.d.y * cur.d.x);
    // Where the moved lines cross, unless they are near parallel (20 degrees) or the crossing runs away along an edge
    // (further than CORNER_RUN times the larger move): then a jog between the two moved edges keeps the change local.
    const x = sin >= Math.sin((20 * Math.PI) / 180) ? intersectLines(prev, cur) : null;
    if (x !== null && dist(x, v) <= CORNER_RUN * Math.max(Math.abs(prev.o), Math.abs(cur.o)) + 0.3) {
      out.push(x);
    } else {
      out.push({ x: v.x + prev.o * prev.nrm.x, y: v.y + prev.o * prev.nrm.y });
      out.push({ x: v.x + cur.o * cur.nrm.x, y: v.y + cur.o * cur.nrm.y });
    }
  }
  // Drop repeated corners.
  return out.filter((q, i) => {
    const p = out[(i + out.length - 1) % out.length]!;
    return Math.hypot(q.x - p.x, q.y - p.y) > 1e-6;
  });
}

export function median(v: readonly number[]): number {
  if (v.length === 0) return Number.NaN;
  const a = Float64Array.from(v).sort();
  const m = a.length >> 1;
  return a.length % 2 === 1 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
