// Hidden edges from the photo: where the height map cannot see an eave (eave support 'none': a crown over it, or
// something as high beside it), look for the roof's edge in Google's true-ortho photo (the rgb layer, made from the
// same capture and on the same grid as the height map, so no alignment is needed).
//
// The search is a directed hypothesis test, not free line detection: the edge's direction is known (the outline is
// already squared to the house), so only its offset along the outward normal is searched. For each candidate offset d
// the photo is read in a strip on each side of the line; each pixel is roof-coloured (the colour of this edge's own
// visible roof, learned from a strip well inside the edge), foliage (the estimator's vegetation test) or other.
// Foliage and near-black shadow carry no evidence and are left out. The contrast at d is the roof share inside minus
// the roof share outside. An edge moves only when:
//   - enough of both strips is visible (coverage),
//   - the contrast at the best offset is high and clearly higher than at the current edge (gain),
//   - the columns along the edge agree on it independently (consensus: a single gutter, a path or a shadow line that
//     happens to be parallel does not run the whole edge),
//   - and the heights do not contradict it: an outward move may not sweep over ground (yard seen as yard) or another
//     roof part, an inward move must cut off canopy, not visible smooth roof.
// Otherwise the current edge is kept, with a typed reason. Moved edges are re-intersected with their neighbours; a
// result that self-intersects, moves a corner too far, or changes the area by more than a quarter is not used.
//
// Pure, deterministic (no randomness), never throws: bad input returns { ok: false, reason }. Coordinates are the
// window's raster-local metres (x east from the left edge, y north from the top, so y <= 0), as eave-support.ts.
import { eaveSupport, crownFromGreen, type EaveSupportClass } from './eave-support.ts';
import { dist, intersectLines, type Line, selfIntersects, signedArea, type XY } from './geom.ts';

export type PhotoEdgeParams = {
  /** An edge is a candidate when at least this much of it (metres) has no eave support... */
  minHiddenM: number;
  /** ...and that is at least this share of it. */
  minHiddenShare: number;
  /** At least this share of the edge's hidden samples must be hidden by a crown (eave-support reason 'crown'). */
  minCrownShare: number;
  /** Height roughness (|4z - its four neighbours|, metres) of foliage, and the share of rough points outside a sample. */
  roughM: number;
  roughShare: number;
  /** Offsets searched, metres along the outward normal: inward to -searchInM, outward to +searchOutM. */
  searchInM: number;
  searchOutM: number;
  /** Step of the offset search and of the columns along the edge, metres (the 0.1 m HIGH pixel). */
  stepM: number;
  /** Width of the strip read on each side of a hypothesis line, metres. */
  bandM: number;
  /** The colour model of the edge's roof is learned from this strip inside the edge, metres. */
  modelFromM: number;
  modelToM: number;
  /** At least this many model pixels, or the edge is declined ('no-model'). */
  minModelPx: number;
  /** Chromaticity tolerance: madK robust sigmas of the model, but never less than chromaFloor. */
  madK: number;
  chromaFloor: number;
  /** Luminance band round the model's median: shade darkens a roof, sun on a gutter brightens it. */
  lumLo: number;
  lumHi: number;
  /** Pixels darker than this luminance (0-255) are deep shadow: no evidence either way. */
  darkLum: number;
  /** At least this share of each strip must be informative (not foliage, not deep shadow). */
  minCoverage: number;
  /** Roof share inside minus outside at the chosen line. */
  minContrast: number;
  /** ... and at least this much more than at the current edge. */
  minGain: number;
  /** Share of the edge's columns whose own best offset is within consensusM of the chosen one. */
  minConsensus: number;
  consensusM: number;
  /** Share of columns that must have an opinion at all (enough visible pixels on both sides). */
  minColumns: number;
  /** A best offset closer than this to the current edge confirms it (no move). */
  minMoveM: number;
  /** Outward moves: swept pixels this far below the eave height are ground; at most maxGroundShare of them. */
  groundDropM: number;
  maxGroundShare: number;
  /** Outward moves: at most this share of the swept pixels may be another mask part (a neighbour's roof). */
  maxNeighbourShare: number;
  /**
   * Inward moves: at least this share of the swept pixels must be occluded (a crown, foliage, deep shadow, or something
   * standing above the eave): what is cut off is canopy, not visible roof.
   */
  minOccluded: number;
  /** Above the eave height by this much, metres: something standing over the roof line (a branch). */
  aboveEaveM: number;
  /** A corner may not move further than this, metres. */
  maxCornerMoveM: number;
  /** The outline's area may not change by more than this share. */
  maxAreaChange: number;
};

/**
 * Principled starting values (see docs/roof-3d/photo.md): the search range is the survey's (-1.5 to +2.5 m: an eave
 * overhang hidden under a crown is rarely more than 2 m past the visible wall line); 0.6 m strips are six pixels at
 * HIGH and two at MEDIUM; the contrast thresholds ask for a clear majority change of colour across the line.
 */
export const DEFAULT_PHOTO_EDGE: PhotoEdgeParams = {
  minHiddenM: 2,
  minHiddenShare: 0.5,
  minCrownShare: 0.5,
  roughM: 0.12,
  roughShare: 0.4,
  searchInM: 1.5,
  searchOutM: 2.5,
  stepM: 0.1,
  bandM: 0.6,
  modelFromM: 0.5,
  modelToM: 3,
  minModelPx: 40,
  madK: 3,
  chromaFloor: 0.012,
  lumLo: 0.45,
  lumHi: 1.8,
  darkLum: 22,
  minCoverage: 0.3,
  minContrast: 0.5,
  minGain: 0.25,
  minConsensus: 0.4,
  consensusM: 0.3,
  minColumns: 0.3,
  minMoveM: 0.2,
  groundDropM: 1,
  maxGroundShare: 0.1,
  maxNeighbourShare: 0.05,
  minOccluded: 0.5,
  aboveEaveM: 0.5,
  maxCornerMoveM: 3.5,
  maxAreaChange: 0.25,
};

/** What happened to one outline edge. */
export type PhotoEdgeStatus = 'moved' | 'confirmed' | 'declined' | 'skipped';
export const PHOTO_EDGE_REASONS = [
  'supported',
  'short',
  'wall',
  'not-crown',
  'no-model',
  'no-coverage',
  'weak-contrast',
  'no-gain',
  'no-consensus',
  'ground',
  'neighbour-roof',
  'not-occluded',
  'corner',
  'large-change',
] as const;
export type PhotoEdgeReason = (typeof PHOTO_EDGE_REASONS)[number];

export type PhotoEdge = {
  /** Index of the edge in the input outline. */
  edge: number;
  status: PhotoEdgeStatus;
  /** Why it was skipped or declined (null when moved or confirmed). */
  reason: PhotoEdgeReason | null;
  /** The chosen offset along the outward normal, metres (positive: outward); 0 unless moved. */
  offsetM: number;
  /** Contrast at the chosen offset and at the current edge, when measured. */
  contrast: number | null;
  contrast0: number | null;
  /** Share of the swept pixels that are occluded (see minOccluded), when a move was tested. */
  occluded?: number;
};

export type PhotoEdgeRaster = {
  width: number;
  height: number;
  pixelSizeM: number;
  dsm: Float32Array;
  /** The photo on the same grid, 3 bytes a pixel (R, G, B). */
  rgb: Uint8Array;
  /** Google's mask, every part (non-zero: roof). */
  mask: Uint8Array;
  /** This roof's own pixels (1), to tell another mask part from it. */
  roof: Uint8Array;
  /** Optional: 1 where the photo is green (vegetation); computed from rgb when absent. */
  green?: Uint8Array | null;
};

export type PhotoEdgeResult =
  | {
      ok: true;
      outline: XY[];
      edges: PhotoEdge[];
      /** For each output vertex, the input edges whose line it lies on that were moved (empty: not moved). */
      movedEdges: number[];
    }
  | { ok: false; reason: 'bad-raster' | 'bad-outline' };

const PIX_ROOF = 1;
const PIX_OTHER = 0;
const PIX_NONE = -1;

function median(xs: number[]): number {
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 === 1 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/** The estimator's vegetation test on one pixel (roof-3d.ts greenOf). */
function isGreen(r: number, g: number, b: number): boolean {
  return g >= r && g >= b && 2 * g - r - b >= 20;
}

/**
 * The outline with its hidden edges moved to where the photo shows the roof ending, where it shows that clearly
 * enough; every other edge as it was.
 */
export function photoEdges(outline: readonly XY[], raster: PhotoEdgeRaster, params: Partial<PhotoEdgeParams> = {}): PhotoEdgeResult {
  const p: PhotoEdgeParams = { ...DEFAULT_PHOTO_EDGE, ...params };
  const { width: w, height: h, pixelSizeM: s, dsm, rgb, mask, roof } = raster;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 2 && h > 2 && s > 0 && Number.isFinite(s))) return { ok: false, reason: 'bad-raster' };
  if (dsm.length !== w * h || rgb.length !== 3 * w * h || mask.length !== w * h || roof.length !== w * h) return { ok: false, reason: 'bad-raster' };
  const ring = outline.filter((q, i) => {
    const prev = outline[(i + outline.length - 1) % outline.length]!;
    return prev.x !== q.x || prev.y !== q.y;
  });
  if (ring.length < 3 || !ring.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) return { ok: false, reason: 'bad-outline' };
  const area0 = signedArea(ring);
  if (!(Math.abs(area0) > 1e-6)) return { ok: false, reason: 'bad-outline' };
  const ccw = area0 > 0;

  const green = raster.green != null && raster.green.length === w * h ? raster.green : null;
  const foliage = new Uint8Array(w * h);
  const lum = new Float32Array(w * h);
  const cr = new Float32Array(w * h);
  const cg = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const R = rgb[3 * i]!;
    const G = rgb[3 * i + 1]!;
    const B = rgb[3 * i + 2]!;
    const sum = R + G + B + 1;
    lum[i] = 0.299 * R + 0.587 * G + 0.114 * B;
    cr[i] = R / sum;
    cg[i] = G / sum;
    if ((green !== null ? green[i] === 1 : false) || isGreen(R, G, B)) foliage[i] = 1;
  }
  const eaveRaster = { width: w, height: h, pixelSizeM: s, dsm };
  const crown = crownFromGreen(eaveRaster, foliage);
  const support = eaveSupport(ring, eaveRaster, crown);
  if (!support.ok) return { ok: false, reason: support.reason === 'bad-raster' ? 'bad-raster' : 'bad-outline' };

  const pixelAt = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    if (c < 0 || r < 0 || c >= w || r >= h) return -1;
    return r * w + c;
  };

  // Foliage the colour test misses (shaded or autumn leaves) is still rough in the heights, where a deck or a terrace at
  // eave height is smooth: a hidden sample whose outside is mostly rough is treated as hidden by a crown.
  const rough = (i: number): boolean => {
    if (foliage[i] === 1) return true;
    const c = i % w;
    const r = (i - c) / w;
    if (c < 1 || r < 1 || c >= w - 1 || r >= h - 1) return false;
    const v = Math.abs(4 * dsm[i]! - dsm[i - 1]! - dsm[i + 1]! - dsm[i - w]! - dsm[i + w]!);
    return Number.isFinite(v) && v >= p.roughM;
  };
  const roughOutside = (x: number, y: number, nx: number, ny: number): boolean => {
    let n = 0;
    let k = 0;
    for (let m = 0.4; m <= 1.2 + 1e-9; m += 0.2) {
      const i = pixelAt(x + nx * m, y + ny * m);
      if (i < 0) continue;
      n++;
      if (rough(i)) k++;
    }
    return n > 0 && k >= p.roughShare * n;
  };

  const n = ring.length;
  const lines: (Line | null)[] = new Array<Line | null>(n).fill(null);
  const offsets = new Array<number>(n).fill(0);
  const report: PhotoEdge[] = [];
  const nIn = Math.round(p.searchInM / p.stepM);
  const nOut = Math.round(p.searchOutM / p.stepM);
  const nBand = Math.max(1, Math.round(p.bandM / p.stepM));

  for (let k = 0; k < n; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % n]!;
    const L = dist(a, b);
    const ux = (b.x - a.x) / L;
    const uy = (b.y - a.y) / L;
    const nx = ccw ? uy : -uy;
    const ny = ccw ? -ux : ux;
    const mine = support.samples.filter((q) => q.edge === k);
    const hidden = mine.filter((q) => q.support === ('none' satisfies EaveSupportClass));
    const hiddenM = (hidden.length * L) / Math.max(1, mine.length);
    const entry = (status: PhotoEdgeStatus, reason: PhotoEdgeReason | null, extra: Partial<PhotoEdge> = {}): PhotoEdge => ({ edge: k, status, reason, offsetM: 0, contrast: null, contrast0: null, ...extra });
    if (hidden.length === 0 || hidden.length < p.minHiddenShare * mine.length) {
      report.push(entry('skipped', 'supported'));
      continue;
    }
    if (hiddenM < p.minHiddenM) {
      report.push(entry('skipped', 'short'));
      continue;
    }
    // Why the heights cannot see this eave. A wall or a taller roof beside it (the outside higher) or no heights: not an
    // eave at all. 'level' with no crown near: a deck, a terrace or a porch at eave height, which a roof-coloured photo
    // cannot tell from roof (it is visible, and not in the mask). Only an eave a crown hides is this method's to move.
    const crownN = hidden.filter((q) => q.reason === 'crown').length;
    const wallN = hidden.filter((q) => q.reason === 'taller-neighbour' || q.reason === 'data-gap').length;
    const roughN = hidden.filter((q) => q.reason === 'level' && roughOutside(q.x, q.y, nx, ny)).length;
    if (crownN + roughN < p.minCrownShare * hidden.length) {
      report.push(entry('skipped', wallN > hidden.length / 2 ? 'wall' : 'not-crown'));
      continue;
    }

    // Columns along the edge (0.1 m apart, kept off the corners by half a step) and offsets across it.
    const cols: number[] = [];
    for (let t = p.stepM / 2; t < L; t += p.stepM) cols.push(t);
    const o0 = -nIn - nBand;
    const o1 = nOut + nBand;
    const span = o1 - o0 + 1;
    const pix = new Int32Array(cols.length * span).fill(-1);
    for (let j = 0; j < cols.length; j++) {
      const qx = a.x + ux * cols[j]!;
      const qy = a.y + uy * cols[j]!;
      // A cell at offset o covers (o - 1, o] steps: its centre half a step inside.
      for (let o = o0; o <= o1; o++) pix[j * span + o - o0] = pixelAt(qx + nx * (o - 0.5) * p.stepM, qy + ny * (o - 0.5) * p.stepM);
    }

    // The colour of this edge's own visible roof: a strip well inside it, this roof's pixels, not foliage or shadow.
    const mr: number[] = [];
    const mg: number[] = [];
    const ml: number[] = [];
    const zin: number[] = [];
    const fromO = -Math.round(p.modelToM / p.stepM);
    const toO = -Math.round(p.modelFromM / p.stepM);
    for (let j = 0; j < cols.length; j++) {
      const qx = a.x + ux * cols[j]!;
      const qy = a.y + uy * cols[j]!;
      for (let o = fromO; o <= toO; o++) {
        const i = pixelAt(qx + nx * o * p.stepM, qy + ny * o * p.stepM);
        if (i < 0 || roof[i] !== 1 || foliage[i] === 1 || crown?.[i] === 1 || lum[i]! < p.darkLum) continue;
        mr.push(cr[i]!);
        mg.push(cg[i]!);
        ml.push(lum[i]!);
      }
      for (let o = -5; o <= -2; o++) {
        const i = pixelAt(qx + nx * o * p.stepM, qy + ny * o * p.stepM);
        if (i >= 0 && roof[i] === 1 && Number.isFinite(dsm[i]!)) zin.push(dsm[i]!);
      }
    }
    if (mr.length < p.minModelPx) {
      report.push(entry('declined', 'no-model'));
      continue;
    }
    const medR = median(mr);
    const medG = median(mg);
    const medL = median(ml);
    const tolR = Math.max(p.chromaFloor, p.madK * 1.4826 * median(mr.map((v) => Math.abs(v - medR))));
    const tolG = Math.max(p.chromaFloor, p.madK * 1.4826 * median(mg.map((v) => Math.abs(v - medG))));
    const classOf = (i: number): number => {
      if (i < 0 || foliage[i] === 1 || lum[i]! < p.darkLum) return PIX_NONE;
      const l = lum[i]!;
      return Math.abs(cr[i]! - medR) <= tolR && Math.abs(cg[i]! - medG) <= tolG && l >= p.lumLo * medL && l <= p.lumHi * medL ? PIX_ROOF : PIX_OTHER;
    };
    const cls = new Int8Array(pix.length);
    for (let q = 0; q < pix.length; q++) cls[q] = classOf(pix[q]!);

    // Contrast of the line at offset d (in steps): roof share in (d - band, d] minus in (d, d + band].
    const tally = (j0: number, j1: number, d: number) => {
      let inRoof = 0;
      let inInfo = 0;
      let outRoof = 0;
      let outInfo = 0;
      let cells = 0;
      for (let j = j0; j < j1; j++) {
        for (let o = d - nBand + 1; o <= d; o++) {
          const c = cls[j * span + o - o0]!;
          if (c !== PIX_NONE) inInfo++;
          if (c === PIX_ROOF) inRoof++;
        }
        for (let o = d + 1; o <= d + nBand; o++) {
          const c = cls[j * span + o - o0]!;
          if (c !== PIX_NONE) outInfo++;
          if (c === PIX_ROOF) outRoof++;
        }
        cells += nBand;
      }
      return { inRoof, inInfo, outRoof, outInfo, cells };
    };
    const contrastOf = (t: ReturnType<typeof tally>, cover: number) =>
      t.inInfo >= cover * t.cells && t.outInfo >= cover * t.cells && t.inInfo > 0 && t.outInfo > 0 ? t.inRoof / t.inInfo - t.outRoof / t.outInfo : null;
    let best: number | null = null;
    let bestK = -Infinity;
    for (let d = -nIn; d <= nOut; d++) {
      const kd = contrastOf(tally(0, cols.length, d), p.minCoverage);
      // Ties go to the smaller move (the current edge first).
      if (kd !== null && (kd > bestK + 1e-12 || (Math.abs(kd - bestK) <= 1e-12 && best !== null && Math.abs(d) < Math.abs(best)))) {
        bestK = kd;
        best = d;
      }
    }
    const k0 = contrastOf(tally(0, cols.length, 0), p.minCoverage);
    if (best === null) {
      report.push(entry('declined', 'no-coverage', { contrast0: k0 }));
      continue;
    }
    const measured = { contrast: round3(bestK), contrast0: k0 === null ? null : round3(k0) };
    if (bestK < p.minContrast) {
      report.push(entry('declined', 'weak-contrast', measured));
      continue;
    }
    if (Math.abs(best) * p.stepM < p.minMoveM) {
      report.push(entry('confirmed', null, measured));
      continue;
    }
    if (k0 !== null && bestK - k0 < p.minGain) {
      report.push(entry('declined', 'no-gain', measured));
      continue;
    }
    // Consensus: each column's own best line (with a looser coverage need: one column is few pixels).
    let opinions = 0;
    let agree = 0;
    const tolSteps = Math.round(p.consensusM / p.stepM);
    for (let j = 0; j < cols.length; j++) {
      let cb: number | null = null;
      let ck = -Infinity;
      for (let d = -nIn; d <= nOut; d++) {
        const kd = contrastOf(tally(j, j + 1, d), 0.5);
        if (kd !== null && (kd > ck + 1e-12 || (Math.abs(kd - ck) <= 1e-12 && cb !== null && Math.abs(d) < Math.abs(cb)))) {
          ck = kd;
          cb = d;
        }
      }
      if (cb === null || ck <= 0) continue;
      opinions++;
      if (Math.abs(cb - best) <= tolSteps) agree++;
    }
    if (opinions < p.minColumns * cols.length || agree < p.minConsensus * opinions) {
      report.push(entry('declined', 'no-consensus', measured));
      continue;
    }

    // The heights must not contradict the move.
    const zEave = zin.length > 0 ? median(zin) : Number.NaN;
    let swept = 0;
    let ground = 0;
    let neighbour = 0;
    let occluded = 0;
    const lo = Math.min(0, best) + 1;
    const hi = Math.max(0, best);
    for (let j = 0; j < cols.length; j++) {
      for (let o = lo; o <= hi; o++) {
        const i = pix[j * span + o - o0]!;
        if (i < 0) continue;
        swept++;
        const z = dsm[i]!;
        if (Number.isFinite(zEave) && Number.isFinite(z) && z < zEave - p.groundDropM) ground++;
        if (mask[i] !== 0 && roof[i] !== 1) neighbour++;
        if (foliage[i] === 1 || crown?.[i] === 1 || lum[i]! < p.darkLum || (Number.isFinite(zEave) && Number.isFinite(z) && z > zEave + p.aboveEaveM)) occluded++;
      }
    }
    if (swept > 0) (measured as Partial<PhotoEdge>).occluded = round3(occluded / swept);
    if (best > 0 && (swept === 0 || ground > p.maxGroundShare * swept)) {
      report.push(entry('declined', 'ground', measured));
      continue;
    }
    if (best > 0 && neighbour > p.maxNeighbourShare * swept) {
      report.push(entry('declined', 'neighbour-roof', measured));
      continue;
    }
    if (best < 0 && (swept === 0 || occluded < p.minOccluded * swept)) {
      report.push(entry('declined', 'not-occluded', measured));
      continue;
    }
    const off = best * p.stepM;
    offsets[k] = off;
    lines[k] = { p: { x: a.x + nx * off, y: a.y + ny * off }, d: { x: ux, y: uy } };
    report.push(entry('moved', null, { ...measured, offsetM: round3(off) }));
  }

  // Rebuild the outline: each corner where a moved edge meets its neighbour is their lines' crossing. Moves that put a
  // corner too far away, flip an edge or break the ring are undone one at a time (the largest first).
  for (let attempt = 0; attempt <= n; attempt++) {
    const built = rebuild(ring, lines, ccw);
    let bad: PhotoEdgeReason | null = null;
    if (built === null) bad = 'corner';
    else if (built.maxMove > p.maxCornerMoveM) bad = 'corner';
    else if (selfIntersects(built.ring)) bad = 'corner';
    else if (Math.abs(Math.abs(signedArea(built.ring)) - Math.abs(area0)) > p.maxAreaChange * Math.abs(area0)) bad = 'large-change';
    if (bad === null && built !== null) return { ok: true, outline: built.ring.map(round3xy), edges: report, movedEdges: built.moved };
    let worst = -1;
    for (let k = 0; k < n; k++) if (lines[k] !== null && (worst < 0 || Math.abs(offsets[k]!) > Math.abs(offsets[worst]!))) worst = k;
    if (worst < 0) break;
    lines[worst] = null;
    offsets[worst] = 0;
    report[worst] = { ...report[worst]!, status: 'declined', reason: bad, offsetM: 0 };
  }
  return { ok: true, outline: ring.map((q) => ({ x: q.x, y: q.y })), edges: report, movedEdges: ring.map(() => -1) };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round3xy = (q: XY): XY => ({ x: round3(q.x), y: round3(q.y) });

/** Two directions this close to parallel (sine of the angle) meet in a jog, not a crossing. */
const PARALLEL_SIN = Math.sin((20 * Math.PI) / 180);

/**
 * The ring with the given edges on their new lines. Where an edge moved, its corners are the crossings with its
 * neighbours' lines (moved or not); where the neighbours are parallel, a jog joins them. Null when an edge flips.
 */
function rebuild(ring: readonly XY[], lines: readonly (Line | null)[], ccw: boolean): { ring: XY[]; maxMove: number; moved: number[] } | null {
  const n = ring.length;
  const lineOf = (k: number): Line => {
    const own = lines[k];
    if (own != null) return own;
    const a = ring[k]!;
    const b = ring[(k + 1) % n]!;
    const L = dist(a, b);
    return { p: a, d: { x: (b.x - a.x) / L, y: (b.y - a.y) / L } };
  };
  const out: XY[] = [];
  const moved: number[] = [];
  // Per input corner, its first and last point in `out` (a jog gives two).
  const first: number[] = [];
  const last: number[] = [];
  let maxMove = 0;
  for (let v = 0; v < n; v++) {
    const kPrev = (v + n - 1) % n;
    const kNext = v;
    const old = ring[v]!;
    first.push(out.length);
    if (lines[kPrev] == null && lines[kNext] == null) {
      out.push(old);
      moved.push(-1);
      last.push(out.length - 1);
      continue;
    }
    const l1 = lineOf(kPrev);
    const l2 = lineOf(kNext);
    const cross = Math.abs(l1.d.x * l2.d.y - l1.d.y * l2.d.x);
    if (cross >= PARALLEL_SIN) {
      const q = intersectLines(l1, l2);
      if (q === null) return null;
      out.push(q);
      moved.push(lines[kNext] != null ? kNext : kPrev);
      maxMove = Math.max(maxMove, dist(q, old));
    } else {
      // A jog: the old corner projected onto each line.
      const proj = (l: Line): XY => {
        const t = (old.x - l.p.x) * l.d.x + (old.y - l.p.y) * l.d.y;
        return { x: l.p.x + l.d.x * t, y: l.p.y + l.d.y * t };
      };
      const q1 = proj(l1);
      const q2 = proj(l2);
      out.push(q1, q2);
      moved.push(lines[kPrev] != null ? kPrev : -1, lines[kNext] != null ? kNext : -1);
      maxMove = Math.max(maxMove, dist(q1, old), dist(q2, old));
    }
    last.push(out.length - 1);
  }
  // No edge may flip direction (a neighbour's move pushing a corner past the edge's far corner).
  for (let k = 0; k < n; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % n]!;
    const qa = out[last[k]!]!;
    const qb = out[first[(k + 1) % n]!]!;
    if ((qb.x - qa.x) * (b.x - a.x) + (qb.y - qa.y) * (b.y - a.y) <= 0) return null;
  }
  const clean: XY[] = [];
  const cleanMoved: number[] = [];
  for (let i = 0; i < out.length; i++) {
    const prev = clean[clean.length - 1];
    if (prev !== undefined && dist(prev, out[i]!) < 1e-6) continue;
    clean.push(out[i]!);
    cleanMoved.push(moved[i]!);
  }
  if (clean.length < 3) return null;
  // The winding must survive too.
  const area = signedArea(clean);
  if (ccw ? area <= 0 : area >= 0) return null;
  return { ring: clean, maxMove, moved: cleanMoved };
}
