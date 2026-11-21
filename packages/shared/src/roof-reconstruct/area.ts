// Roof area at the roof's edges, where a height map seen from above is wrong in two known ways (docs/roof-3d/area.md):
//
// 1. The mask runs fat. Google's heights smear a roof's edge outwards (the fall to the ground is half-way down about
//    0.35 m outside the eave a report draws), and on the sunlit sides the mask takes in the bright band of wall and
//    fascia the photo shows beside the roof. The photo is sharper than the heights: across each outline edge the
//    roof's own colour (learned from a strip inside the edge) ends somewhere, and the half-way point of that colour
//    change is the eave (`eaveMoves`). An edge moves in to it, never out; an edge the photo says nothing about (no
//    colour change in reach: a dark roof beside its own shadow) moves in by a small fixed inset, the mask's usual
//    excess; an edge under a tree crown is left where it is. The trim is applied to the finished roof (`trimRoof`):
//    the outline's edges move, with the faces' corners and the lines' ends that lie on them, so no face or line is
//    made or lost by it.
//
// 2. A roof runs on under the roof above it. Where a lower face meets a wall (a flashing or step-flashing line), what
//    is seen from above is the upper roof's edge; the lower roof carries on under that overhang to the wall, and a
//    measurer prices it. Each wall line adds its plan length times the overhang's depth to the lower face (`tuckUnder`).
//
// Pure, deterministic, never throws. Coordinates are the crop's raster-local metres (x east, y north, so y <= 0).
import { dist, intersectLines, nearestOnSegment, pointInRing, selfIntersects, signedArea, type XY } from './geom.ts';

export type AreaParams = {
  /** Eaves from the photo: an outline edge moves in to where the photo shows the roof's colour ending. */
  eavePhoto: boolean;
  /** An edge the photo gives no evidence for (or a short one, or with no photo at all) moves in by this, metres. 0 = off. */
  eaveInsetM: number;
  /** A colour change deeper inside the edge than this is not the mask's rim (a band of other roofing, a shadow): no evidence. Metres. */
  eaveMaxInM: number;
  /** Edges shorter than this are not read in the photo, metres. */
  eaveMinEdgeM: number;
  /**
   * An edge moves only where the heights show an eave: they fall by this much (metres) across it along at least
   * `eaveDropShare` of its length. Under a tree crown, against a taller wall or along a level attachment the mask's
   * edge is not a smeared eave, and stays.
   */
  eaveDropM: number;
  eaveDropShare: number;
  /**
   * When the trim is done: true, on the squared outline before the topology (faces fitted on the fat rim are then
   * judged, and dissolved, by the usual cleanup); false, on the finished roof (no face or line is made or lost).
   */
  eaveBeforeTopology: boolean;
  /** The roof's colour has ended where the photo is this far from it (RGB distance, 0-441), or `eaveMadK` robust spreads of the roof's own colour if that is more. */
  eaveMinChange: number;
  eaveMadK: number;
  /** The colour beyond the change is read over this distance past its start, metres. */
  eaveReachM: number;
  /**
   * Roof under an overhang: the depth, metres, a lower face runs on under the edge of the roof above it along each
   * wall line (flashing, step flashing). 0.3 m is a 12 inch overhang, and the median width of the strips an EagleView
   * report prices there (docs/roof-3d/area.md). 0 = off.
   */
  tuckUnderM: number;
};

export const DEFAULT_AREA_PARAMS: AreaParams = {
  eavePhoto: true,
  eaveInsetM: 0.1,
  eaveMaxInM: 0.5,
  eaveMinEdgeM: 2,
  eaveDropM: 1,
  eaveDropShare: 0.6,
  eaveBeforeTopology: true,
  eaveMinChange: 22,
  eaveMadK: 4,
  eaveReachM: 0.5,
  tuckUnderM: 0.3,
};

/** The photo (3 bytes a pixel) and where it is green, on the whole raster's grid, and the crop's first column and row in it. */
export type AreaPhoto = { rgb: Uint8Array; green: Uint8Array | null; width: number; height: number; c0: number; r0: number };
/** The crop's heights (NaN where there are none). */
export type AreaHeights = { dsm: Float32Array; w: number; h: number };

/** What happened to one outline edge (`from`: its first corner's index): how far it moved (metres, <= 0 = inwards) and on what evidence. */
export type EaveTrimEdge = { from: number; lengthM: number; moveM: number; by: 'photo' | 'inset' | 'canopy' | 'none'; photoM: number | null };

/** Offsets across an edge, metres along its outward normal: the roof's colour is learned on MODEL_FROM..MODEL_TO, its end searched from MODEL_TO out to SEARCH_OUT. */
const STEP_M = 0.1;
const MODEL_FROM_M = -1.6;
const MODEL_TO_M = -0.8;
const SEARCH_OUT_M = 0.8;
/** Columns along an edge, metres apart, and the room left at each corner. */
const ALONG_M = 0.2;
const CORNER_M = 0.5;
/** Leaves over this share of the photo just outside an edge: the edge is a crown's, not an eave. */
const CANOPY_SHARE = 0.3;
const CANOPY_OUT_M = 0.6;
/** The trimmed outline may not lose more than this share of its area (then something else is wrong: it is not used). */
const MAX_AREA_LOSS = 0.2;

function median(v: number[]): number {
  v.sort((p, q) => p - q);
  const n = v.length;
  return n === 0 ? Number.NaN : n % 2 === 1 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
}

/**
 * Where the photo shows the roof's colour ending across the edge a-b (outward unit normal n): the offset of the
 * half-way point of the first colour change going outwards, metres (negative inside the edge); null when the photo
 * shows no change in reach, or one already there at the search's start or deeper than `eaveMaxInM`. `canopy`: leaves
 * just outside the edge.
 */
export function roofEndInPhoto(a: XY, b: XY, n: XY, s: number, photo: AreaPhoto, prm: AreaParams): { atM: number | null; canopy: boolean } {
  const L = dist(a, b);
  const none = { atM: null, canopy: false };
  if (!(L > 0)) return none;
  const ex = (b.x - a.x) / L;
  const ey = (b.y - a.y) / L;
  const margin = Math.min(CORNER_M, L / 4);
  const cols: number[] = [];
  for (let t = margin; t <= L - margin + 1e-9; t += ALONG_M) cols.push(t);
  if (cols.length < 4) return none;
  const nOff = Math.round((SEARCH_OUT_M - MODEL_FROM_M) / STEP_M) + 1;
  const offAt = (j: number) => MODEL_FROM_M + j * STEP_M;
  const start = Math.round((MODEL_TO_M - MODEL_FROM_M) / STEP_M);
  // Samples: columns x offsets x 3 (NaN: no photo there, or leaves).
  const px = new Float64Array(cols.length * nOff * 3).fill(Number.NaN);
  const { rgb, green, width: W, height: H } = photo;
  let outside = 0;
  let leaves = 0;
  for (let i = 0; i < cols.length; i++) {
    const bx = a.x + ex * cols[i]!;
    const by = a.y + ey * cols[i]!;
    for (let j = 0; j < nOff; j++) {
      const d = offAt(j);
      // Whole-raster pixel coordinates of the sample; pixel (c, r) has its centre at (c + 0.5, r + 0.5).
      const u = (bx + n.x * d) / s + photo.c0 - 0.5;
      const v = -(by + n.y * d) / s + photo.r0 - 0.5;
      const c = Math.floor(u);
      const r = Math.floor(v);
      if (c < 0 || r < 0 || c + 1 >= W || r + 1 >= H) continue;
      const justOut = d > 0 && d <= CANOPY_OUT_M + 1e-9;
      if (justOut) outside++;
      const nearest = Math.round(v) * W + Math.round(u);
      if (green !== null && green[nearest] === 1) {
        if (justOut) leaves++;
        continue;
      }
      const fu = u - c;
      const fv = v - r;
      const i00 = 3 * (r * W + c);
      const i01 = i00 + 3;
      const i10 = i00 + 3 * W;
      const i11 = i10 + 3;
      // Black where the layers have no photo.
      if (rgb[i00]! + rgb[i00 + 1]! + rgb[i00 + 2]! === 0 && rgb[i11]! + rgb[i11 + 1]! + rgb[i11 + 2]! === 0) continue;
      const at = 3 * (i * nOff + j);
      for (let k = 0; k < 3; k++) px[at + k] = (rgb[i00 + k]! * (1 - fu) + rgb[i01 + k]! * fu) * (1 - fv) + (rgb[i10 + k]! * (1 - fu) + rgb[i11 + k]! * fu) * fv;
    }
  }
  const canopy = outside > 0 && leaves >= CANOPY_SHARE * outside;
  // The roof's colour: the medians of the strip inside the edge, and its robust spread.
  const model: number[][] = [[], [], []];
  for (let i = 0; i < cols.length; i++) {
    for (let j = 0; j <= start; j++) {
      const at = 3 * (i * nOff + j);
      if (Number.isNaN(px[at]!)) continue;
      for (let k = 0; k < 3; k++) model[k]!.push(px[at + k]!);
    }
  }
  if (model[0]!.length < 12) return { atM: null, canopy };
  const roofRgb = [median(model[0]!.slice()), median(model[1]!.slice()), median(model[2]!.slice())];
  const spread: number[] = [];
  for (let m = 0; m < model[0]!.length; m++) spread.push(Math.hypot(model[0]![m]! - roofRgb[0]!, model[1]![m]! - roofRgb[1]!, model[2]![m]! - roofRgb[2]!));
  const mad = median(spread) * 1.4826;
  // The photo's distance from the roof's colour at each offset: the columns' median colour there.
  const delta = new Float64Array(nOff).fill(Number.NaN);
  for (let j = 0; j < nOff; j++) {
    const ch: number[][] = [[], [], []];
    for (let i = 0; i < cols.length; i++) {
      const at = 3 * (i * nOff + j);
      if (Number.isNaN(px[at]!)) continue;
      for (let k = 0; k < 3; k++) ch[k]!.push(px[at + k]!);
    }
    if (ch[0]!.length < Math.max(3, cols.length / 2)) continue;
    delta[j] = Math.hypot(median(ch[0]!) - roofRgb[0]!, median(ch[1]!) - roofRgb[1]!, median(ch[2]!) - roofRgb[2]!);
  }
  const threshold = Math.max(prm.eaveMinChange, prm.eaveMadK * mad);
  if (!(delta[start]! <= threshold)) return { atM: null, canopy };
  let first = -1;
  for (let j = start + 1; j < nOff; j++) {
    if (Number.isNaN(delta[j]!)) break;
    if (delta[j]! > threshold) {
      first = j;
      break;
    }
  }
  if (first < 0) return { atM: null, canopy };
  const last = Math.min(nOff - 1, first + Math.round(prm.eaveReachM / STEP_M));
  let peak = delta[first]!;
  for (let j = first; j <= last; j++) if (delta[j]! > peak) peak = delta[j]!;
  const inside: number[] = [];
  for (let j = 0; j <= start; j++) if (!Number.isNaN(delta[j]!)) inside.push(delta[j]!);
  const base = inside.length > 0 ? median(inside) : 0;
  const half = base + (peak - base) / 2;
  for (let j = start + 1; j <= last; j++) {
    if (Number.isNaN(delta[j]!) || Number.isNaN(delta[j - 1]!)) break;
    if (delta[j]! >= half) {
      const atM = offAt(j - 1) + ((half - delta[j - 1]!) / Math.max(1e-9, delta[j]! - delta[j - 1]!)) * STEP_M;
      return { atM: atM < -prm.eaveMaxInM ? null : atM, canopy };
    }
  }
  return { atM: null, canopy };
}

/**
 * The ring with each edge k (ring[k] to ring[k + 1]) moved along its outward normal by moves[k] metres (negative: in),
 * its corners where the moved edges' lines cross. Null when the result is not a simple ring the same way round.
 */
export function moveEdges(ring: readonly XY[], moves: readonly number[]): XY[] | null {
  const n = ring.length;
  if (n < 3 || moves.length !== n) return null;
  const turn = Math.sign(signedArea(ring));
  if (turn === 0) return null;
  const dirs: XY[] = [];
  const normals: XY[] = [];
  for (let k = 0; k < n; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % n]!;
    const L = dist(a, b);
    const d = L > 1e-9 ? { x: (b.x - a.x) / L, y: (b.y - a.y) / L } : { x: 1, y: 0 };
    dirs.push(d);
    // Outward: to the right of the direction of travel on a counter-clockwise ring.
    normals.push({ x: d.y * turn, y: -d.x * turn });
  }
  const mv = moves.slice();
  for (let pass = 0; pass < 6; pass++) {
    const out: XY[] = [];
    for (let k = 0; k < n; k++) {
      const p = (k + n - 1) % n;
      const corner = ring[k]!;
      const mean = { x: corner.x + (normals[p]!.x * mv[p]! + normals[k]!.x * mv[k]!) / 2, y: corner.y + (normals[p]!.y * mv[p]! + normals[k]!.y * mv[k]!) / 2 };
      const cross = dirs[p]!.x * dirs[k]!.y - dirs[p]!.y * dirs[k]!.x;
      let q: XY | null = null;
      if (Math.abs(cross) >= 0.14) {
        q = intersectLines(
          { p: { x: ring[p]!.x + normals[p]!.x * mv[p]!, y: ring[p]!.y + normals[p]!.y * mv[p]! }, d: dirs[p]! },
          { p: { x: corner.x + normals[k]!.x * mv[k]!, y: corner.y + normals[k]!.y * mv[k]! }, d: dirs[k]! },
        );
        if (q !== null && dist(q, corner) > 3 * Math.max(Math.abs(mv[p]!), Math.abs(mv[k]!)) + 0.05) q = null;
      }
      out.push(q ?? mean);
    }
    // An edge turned round (a short jog between two edges moved by different amounts): its neighbours move alike, and again.
    let flipped = false;
    for (let k = 0; k < n; k++) {
      const a = out[k]!;
      const b = out[(k + 1) % n]!;
      if ((b.x - a.x) * dirs[k]!.x + (b.y - a.y) * dirs[k]!.y >= -1e-9) continue;
      const p = (k + n - 1) % n;
      const q = (k + 1) % n;
      const m = (mv[p]! + mv[q]!) / 2;
      mv[p] = m;
      mv[q] = m;
      flipped = true;
    }
    if (flipped) continue;
    if (selfIntersects(out) || Math.sign(signedArea(out)) !== turn) return null;
    return out;
  }
  return null;
}

/** Where the heights are read across an edge, metres from it: on the roof, and past the eave's smear (as eave-support.ts). */
const DROP_INSIDE_M = [-0.5, -0.4, -0.3, -0.2];
const DROP_OUTSIDE_M = [0.6, 0.7, 0.8, 0.9, 1.0];

/**
 * The share of the edge a-b (outward unit normal n) along which the heights fall by `dropM` or more from just inside
 * it to just outside: a real eave. 0 when it cannot be read.
 */
export function eaveDropShare(a: XY, b: XY, n: XY, s: number, heights: AreaHeights, dropM: number): number {
  const L = dist(a, b);
  if (!(L > 0)) return 0;
  const margin = Math.min(CORNER_M, L / 4);
  const zAt = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    return c < 0 || r < 0 || c >= heights.w || r >= heights.h ? Number.NaN : heights.dsm[r * heights.w + c]!;
  };
  let cols = 0;
  let falls = 0;
  for (let t = margin; t <= L - margin + 1e-9; t += ALONG_M) {
    const x = a.x + ((b.x - a.x) * t) / L;
    const y = a.y + ((b.y - a.y) * t) / L;
    const inside = DROP_INSIDE_M.map((d) => zAt(x + n.x * d, y + n.y * d)).filter((z) => Number.isFinite(z));
    const outside = DROP_OUTSIDE_M.map((d) => zAt(x + n.x * d, y + n.y * d)).filter((z) => Number.isFinite(z));
    cols++;
    if (inside.length >= 2 && outside.length >= 2 && median(inside) - median(outside) >= dropM) falls++;
  }
  return cols > 0 ? falls / cols : 0;
}

/**
 * How far each outline edge moves (metres along its outward normal, <= 0): in to where the photo shows the roof ending
 * (roofEndInPhoto), or by the fixed inset where the photo gives no evidence; an edge under a crown stays.
 */
export function eaveMoves(outline: readonly XY[], s: number, photo: AreaPhoto | null, heights: AreaHeights | null, prm: AreaParams): EaveTrimEdge[] {
  const n = outline.length;
  const edges: EaveTrimEdge[] = [];
  if (n < 3 || !(s > 0) || (!prm.eavePhoto && !(prm.eaveInsetM > 0))) return edges;
  const turn = Math.sign(signedArea(outline));
  if (turn === 0) return edges;
  const usable = prm.eavePhoto && photo !== null && photo.rgb.length === 3 * photo.width * photo.height && (photo.green === null || photo.green.length === photo.width * photo.height);
  const inset = Math.max(0, prm.eaveInsetM);
  for (let k = 0; k < n; k++) {
    const a = outline[k]!;
    const b = outline[(k + 1) % n]!;
    const L = dist(a, b);
    let move = -inset;
    let by: EaveTrimEdge['by'] = inset > 0 ? 'inset' : 'none';
    let photoM: number | null = null;
    const normal = L > 0 ? { x: ((b.y - a.y) / L) * turn, y: (-(b.x - a.x) / L) * turn } : { x: 0, y: 0 };
    if (heights !== null && !(eaveDropShare(a, b, normal, s, heights, prm.eaveDropM) >= prm.eaveDropShare)) {
      // No eave in the heights (a crown over it, a wall beside it, a level attachment): the edge is not a smeared eave.
      move = 0;
      by = 'none';
    } else if (usable && L >= prm.eaveMinEdgeM) {
      const seen = roofEndInPhoto(a, b, normal, s, photo, prm);
      photoM = seen.atM;
      if (seen.atM !== null) {
        move = Math.min(0, seen.atM);
        by = 'photo';
      } else if (seen.canopy) {
        move = 0;
        by = 'canopy';
      }
    }
    edges.push({ from: k, lengthM: L, moveM: move === 0 ? 0 : move, by, photoM });
  }
  return edges;
}

/**
 * The squared outline with its eaves trimmed (eaveMoves), before the roof's topology is built on it. `outline` null
 * when nothing moves or the trimmed outline is not usable (then the outline is kept as it is).
 */
export function trimOutline(outline: readonly XY[], s: number, photo: AreaPhoto | null, heights: AreaHeights | null, prm: AreaParams): { outline: XY[] | null; edges: EaveTrimEdge[] } {
  const edges = eaveMoves(outline, s, photo, heights, prm);
  if (edges.length !== outline.length || edges.every((e) => e.moveM === 0)) return { outline: null, edges };
  const now = moveEdges(outline, edges.map((e) => e.moveM));
  if (now === null) return { outline: null, edges };
  const before = Math.abs(signedArea(outline));
  const after = Math.abs(signedArea(now));
  if (!(after <= before * (1 + 1e-9)) || after < (1 - MAX_AREA_LOSS) * before) return { outline: null, edges };
  return { outline: now, edges };
}

/** A polygon's mean width: twice its area over its perimeter. */
function widthOf(ring: readonly XY[]): number {
  let perimeter = 0;
  for (let k = 0; k < ring.length; k++) perimeter += dist(ring[k]!, ring[(k + 1) % ring.length]!);
  return perimeter > 0 ? (2 * Math.abs(signedArea(ring))) / perimeter : 0;
}

/** A point is on the outline when it is this near one of its edges, metres (topology places edge corners on it exactly). */
const ON_OUTLINE_M = 1e-4;

/**
 * Where a point of a roof drawn on the outline `was` goes when the outline is trimmed to `now` (the same corners in
 * the same order): a corner to its corner, a point on an edge straight across onto the moved edge, a point the trim
 * left outside onto the new outline; every other point stays.
 */
export function trimmedPoint(was: readonly XY[], now: readonly XY[]): (p: XY) => XY {
  const n = was.length;
  return (p) => {
    for (let k = 0; k < n; k++) if (dist(p, was[k]!) < ON_OUTLINE_M) return now[k]!;
    for (let k = 0; k < n; k++) {
      if (nearestOnSegment(p, was[k]!, was[(k + 1) % n]!).d < ON_OUTLINE_M) return nearestOnSegment(p, now[k]!, now[(k + 1) % n]!).q;
    }
    if (pointInRing(p, now)) return p;
    let best = p;
    let bd = Infinity;
    for (let k = 0; k < n; k++) {
      const q = nearestOnSegment(p, now[k]!, now[(k + 1) % n]!);
      if (q.d < bd) {
        bd = q.d;
        best = q.q;
      }
    }
    return best;
  };
}

export type TrimmedRoof<F, L> = { outline: XY[]; faces: F[]; lines: L[]; edges: EaveTrimEdge[]; at: (p: XY) => XY };

/**
 * The finished roof with its eaves trimmed (eaveMoves): the outline's edges moved in, and the faces' corners and the
 * lines' ends that lay on it moved with them. The faces and the lines stay what they are: an edge whose move would
 * leave a face under `tinyFaceM2` or thinner than `thinFaceM` (when it was not) keeps its place. Null when nothing
 * moves or the trimmed outline is not usable (then the roof is kept as it is).
 */
export function trimRoof<F extends { ring: XY[]; areaM2: number }, L extends { a: XY; b: XY; lengthM: number; riseM: number }>(
  outline: readonly XY[],
  s: number,
  photo: AreaPhoto | null,
  heights: AreaHeights | null,
  prm: AreaParams,
  faces: readonly F[],
  lines: readonly L[],
  limits: { tinyFaceM2: number; thinFaceM: number },
): TrimmedRoof<F, L> | null {
  const edges = eaveMoves(outline, s, photo, heights, prm);
  const n = outline.length;
  if (edges.length !== n) return null;
  const before = Math.abs(signedArea(outline));
  for (let pass = 0; pass < 4; pass++) {
    if (edges.every((e) => e.moveM === 0)) return null;
    const now = moveEdges(outline, edges.map((e) => e.moveM));
    if (now === null) return null;
    const after = Math.abs(signedArea(now));
    if (!(after <= before * (1 + 1e-9)) || after < (1 - MAX_AREA_LOSS) * before) return null;
    const at = trimmedPoint(outline, now);
    const rings = faces.map((f) => {
      const ring: XY[] = [];
      for (const p of f.ring) {
        const q = at(p);
        if (ring.length === 0 || dist(ring[ring.length - 1]!, q) > 1e-9) ring.push(q);
      }
      while (ring.length > 1 && dist(ring[0]!, ring[ring.length - 1]!) <= 1e-9) ring.pop();
      return ring;
    });
    // Faces the trim would turn into slivers: the outline edges they lie on stay where they are, and again.
    let held = false;
    faces.forEach((f, k) => {
      const was = Math.abs(signedArea(f.ring));
      const is = rings[k]!.length >= 3 ? Math.abs(signedArea(rings[k]!)) : 0;
      const thin = rings[k]!.length < 3 || widthOf(rings[k]!) < limits.thinFaceM;
      const worse = !(is > 0) || (is < limits.tinyFaceM2 && was >= limits.tinyFaceM2) || (thin && widthOf(f.ring) >= limits.thinFaceM);
      if (!worse) return;
      for (const p of f.ring) {
        for (let e = 0; e < n; e++) {
          if (edges[e]!.moveM !== 0 && nearestOnSegment(p, outline[e]!, outline[(e + 1) % n]!).d < ON_OUTLINE_M) {
            edges[e] = { ...edges[e]!, moveM: 0, by: 'none' };
            held = true;
          }
        }
      }
    });
    if (held) continue;
    if (rings.some((r) => r.length < 3)) return null;
    // A face's area follows its polygon's (a face drawn from its pixels carries its pixel area: scaled alike).
    const outFaces = faces.map((f, k) => {
      const was = Math.abs(signedArea(f.ring));
      return { ...f, ring: rings[k]!, areaM2: was > 0 ? (f.areaM2 * Math.abs(signedArea(rings[k]!))) / was : f.areaM2 };
    });
    const outLines: L[] = [];
    for (const l of lines) {
      const a = at(l.a);
      const b = at(l.b);
      const was = dist(l.a, l.b);
      const is = dist(a, b);
      // A line the trim closed up (it lay in the rim cut off) is gone; any other keeps its slope.
      if (is < 0.02 && was >= 0.02) continue;
      const k = was > 1e-9 ? is / was : 1;
      outLines.push({ ...l, a, b, lengthM: l.lengthM * k, riseM: l.riseM * k });
    }
    return { outline: now, faces: outFaces, lines: outLines, edges, at };
  }
  return null;
}

/**
 * Plan area (square metres) each face has under the overhang of a roof above it: along every flashing and
 * step-flashing line, the line's plan length times `tuckUnderM`, on the line's (lower) face.
 */
export function tuckUnder(lines: readonly { kind: string; a: XY; b: XY; faces: readonly number[] }[], faces: number, prm: AreaParams): number[] {
  const out = new Array<number>(faces).fill(0);
  if (!(prm.tuckUnderM > 0)) return out;
  for (const l of lines) {
    if (l.kind !== 'flashing' && l.kind !== 'step-flashing') continue;
    const f = l.faces[0];
    if (f === undefined || f < 0 || f >= faces) continue;
    out[f]! += dist(l.a, l.b) * prm.tuckUnderM;
  }
  return out;
}
