// Hidden eaves inferred from the roof's own planes (docs/roof-3d/planes.md).
//
// Where a tree crown stands over an eave, the height map shows the crown, not the drop to the yard, so the mask (and the
// outline traced from it) stops wherever the crown starts: short of the eave, in a ragged staircase, with chamfered
// corners. The roof's planes are still known from the visible part of each face, and on most houses every eave of a face
// sits at one height (the wall plate), which the face's visible eaves show. A face's hidden eave then lies where its
// plane comes down to that height: the iso-line a x + b y + c = h_e.
//
// The step finds runs of outline edges the heights cannot vouch for (eave support 'none', eave-support.ts), splits each
// run by the face it bounds, and replaces every piece that lies on its face's downhill side with that face's eave line;
// neighbouring pieces are re-intersected, so a hidden hip corner becomes the corner where two eave lines meet (on the
// hip's extension) instead of the crown's chamfer. Rakes (a face's climbing side) are left alone.
//
// It only moves edges the heights cannot check: an edge the height map shows dropping to the yard is never touched.
// Every move is guarded (the new line must stay within [-1, +3] m of every corner it replaces, agree with the run's own
// visible samples, and sweep no visible yard or other building) and every refusal has a machine-readable reason.
// Inferred edges stay unverified: eave support on the final outline still reports them as 'none'.
//
// Pure, deterministic, a few milliseconds a house; never throws (bad input returns { ok: false, reason }).
// Coordinates: raster-local metres (x east from the grid's left edge, y north from its top edge, so y <= 0); pixel
// (col, row) has its centre at ((col + 0.5) s, -(row + 0.5) s).
import { eaveSupport, type EaveSample } from './eave-support.ts';
import { dist, intersectLines, type Line, pointInRing, selfIntersects, signedArea, type XY } from './geom.ts';
import type { Plane } from './planes.ts';

export type OutlinePlanesParams = {
  /** Faces flatter than this (x/12) are left alone: the iso-line's horizontal error is sigma_h / tan(pitch), about 0.4 m at 3/12. */
  minPitchX12: number;
  /** An edge is a face's eave (for measuring the eave height) when it runs within this many degrees of the face's level direction (topology.ts eaveDeg). */
  eaveDeg: number;
  /** The face owning an edge is the majority face label this far inside it, metres (past the eave's blurred lip). */
  insetM: number;
  /** A face's eave height needs at least this much strongly supported eave, metres. */
  minStrongM: number;
  /** Half-width of the profile read across a strong sample for the drop's centre, metres (at least 3 pixels). */
  descentHalfM: number;
  /** A face's eave height is accepted when its samples' median absolute deviation is at most this, metres. */
  faceMadM: number;
  /** Faces without their own eave height take the house's only when every face's agrees within this, metres. */
  houseAgreeM: number;
  /** An edge is hidden when at least this share of its samples is unverified. */
  hiddenShare: number;
  /** A piece is replaced only when it has at least this much unverified outline, metres. */
  minHiddenM: number;
  /** A piece is on its face's downhill side when its outward normal is within this many degrees of the face's downhill direction. */
  maxNormalDeg: number;
  /**
   * Signed outward distance from the replaced corners to the eave line allowed, metres (negative: the line is inside):
   * every corner at least minOffsetM; the corners between the piece's ends, and the nearer end, at most maxOffsetM.
   */
  minOffsetM: number;
  maxOffsetM: number;
  /** The farther end corner (a chamfer's far end, cut by a crown) at most this far, metres. */
  maxEndOffsetM: number;
  /** The piece's own visible samples (strong or weak) must lie within this (median) of the eave line, metres. */
  visibleAgreeM: number;
  /** The area a move adds is refused when more than this share of it shows ground: lower than the plane by yardDropM. */
  yardShare: number;
  yardDropM: number;
  /** The area a move removes is refused when more than this share of it lies on the face's plane (within onPlaneM). */
  onPlaneShare: number;
  onPlaneM: number;
  /** Two replaced pieces of different faces must meet within this of their planes' crease (horizontally), metres. */
  creaseTolM: number;
  /** Hidden pieces that are no face's eave, at most this long in all, may be dropped for a corner (a chamfer), metres. */
  chamferMaxM: number;
  /** The outline's area may change by at most this share. */
  maxAreaChange: number;
  /** A rebuilt corner may lie at most this far from the nearest old corner, metres. */
  maxCornerMoveM: number;
};

/**
 * The constants, from the geometry they stand for rather than tuned (sensitivity +-20 % in docs/roof-3d/planes.md).
 * The offset and agreement gates come from the methods survey (analysis/outline-methods.md): +3 m is a deep crown bite,
 * -1 m a crown the mask took for roof; 0.3 m is the lidar truth's own edge error.
 */
export const DEFAULT_OUTLINE_PLANES: OutlinePlanesParams = {
  minPitchX12: 3,
  eaveDeg: 45,
  insetM: 0.4,
  minStrongM: 2,
  descentHalfM: 0.5,
  faceMadM: 0.1,
  houseAgreeM: 0.25,
  hiddenShare: 0.5,
  minHiddenM: 1,
  maxNormalDeg: 50,
  minOffsetM: -1,
  maxOffsetM: 3,
  maxEndOffsetM: 4.5,
  visibleAgreeM: 0.3,
  yardShare: 0.1,
  yardDropM: 1,
  onPlaneShare: 0.5,
  onPlaneM: 0.15,
  creaseTolM: 0.3,
  chamferMaxM: 4,
  maxAreaChange: 0.25,
  maxCornerMoveM: 4,
};

/** Why a hidden piece of the outline was left as it was. */
export type PlanesDecline =
  | 'no-face'
  | 'low-pitch'
  | 'not-eave'
  | 'no-eave-height'
  | 'split-level'
  | 'short'
  | 'offset'
  | 'disagrees-visible'
  | 'yard-visible'
  | 'other-building'
  | 'roof-visible'
  | 'no-corner'
  | 'self-intersects'
  | 'large-change';

export const PLANES_DECLINES = [
  'no-face',
  'low-pitch',
  'not-eave',
  'no-eave-height',
  'split-level',
  'short',
  'offset',
  'disagrees-visible',
  'yard-visible',
  'other-building',
  'roof-visible',
  'no-corner',
  'self-intersects',
  'large-change',
] as const satisfies readonly PlanesDecline[];

export type PlanesInput = {
  g: { w: number; h: number };
  s: number;
  /** Heights, metres (NaN: none), row-major on g. */
  dsm: Float32Array;
  /** Face label per pixel (-1: none), on g. */
  labels: Int32Array;
  /** The faces' planes, z = a x + b y + c in these coordinates. */
  planes: readonly Plane[];
  /** 1 where another building's mask part is (a move may not sweep into it); null when unknown. */
  other: Uint8Array | null;
  /** 1 where a tree crown is (only for the unverified reasons); null when unknown. */
  crown: Uint8Array | null;
  /** The outline, counter-clockwise or not. */
  outline: readonly XY[];
};

/** A replaced piece: outline edges `first`..`last` (old numbering, cyclic) now one eave line of `face`. */
export type PlanesChange = { first: number; last: number; face: number; hiddenM: number; minOffsetM: number; maxOffsetM: number };

/** One hidden piece and what became of it. */
export type PlanesPiece = {
  first: number;
  last: number;
  face: number;
  pitchX12: number | null;
  hiddenM: number;
  /** Angle between the piece's outward normal and its face's downhill direction, degrees. */
  normalDeg?: number;
  minOffsetM?: number;
  maxOffsetM?: number;
  outcome: PlanesDecline | 'replaced';
};

export type PlanesResult = {
  ok: true;
  outline: XY[];
  changes: PlanesChange[];
  /** Hidden pieces left alone, by reason. */
  declined: Partial<Record<PlanesDecline, number>>;
  /** The eave height each face uses (null: none), metres. */
  eaveHeights: (number | null)[];
  /** Unverified outline length; the part on pieces with a steep face and a known eave height; the part replaced, metres. */
  hiddenM: number;
  eligibleM: number;
  replacedM: number;
  /** Per face: strong eave samples measured, their median height and its MAD (for development). */
  faceStats: { n: number; h: number | null; mad: number | null }[];
  pieces: PlanesPiece[];
};
export type PlanesFailure = { ok: false; reason: 'bad-input' | 'eave-support' };

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const planeZ = (p: Plane, x: number, y: number) => p.a * x + p.b * y + p.c;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The outline with its hidden eaves moved onto the planes' eave lines (see the head of the file). An outline with
 * nothing hidden, or no face whose eave height is known, comes back unchanged with the reasons.
 */
export function inferHiddenEaves(input: PlanesInput, params: Partial<OutlinePlanesParams> = {}): PlanesResult | PlanesFailure {
  const p: OutlinePlanesParams = { ...DEFAULT_OUTLINE_PLANES, ...params };
  const { g, s, dsm, labels, planes } = input;
  const n = g.w * g.h;
  if (!(g.w > 2 && g.h > 2 && s > 0 && Number.isFinite(s)) || dsm.length !== n || labels.length !== n) return { ok: false, reason: 'bad-input' };
  if ((input.other !== null && input.other.length !== n) || (input.crown !== null && input.crown.length !== n)) return { ok: false, reason: 'bad-input' };
  if (!planes.every((q) => Number.isFinite(q.a) && Number.isFinite(q.b) && Number.isFinite(q.c))) return { ok: false, reason: 'bad-input' };
  // Counter-clockwise (positive area, y north), consecutive duplicates dropped.
  let ring = input.outline.filter((q, i) => {
    const prev = input.outline[(i + input.outline.length - 1) % input.outline.length]!;
    return !(prev.x === q.x && prev.y === q.y);
  });
  if (ring.length < 3 || !ring.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))) return { ok: false, reason: 'bad-input' };
  if (signedArea(ring) < 0) ring = [...ring].reverse();
  const area0 = signedArea(ring);
  if (!(area0 > 1e-6)) return { ok: false, reason: 'bad-input' };

  const support = eaveSupport(ring, { width: g.w, height: g.h, pixelSizeM: s, dsm }, input.crown);
  if (!support.ok) return { ok: false, reason: 'eave-support' };
  const step = support.stepM;
  const bySample = new Map<number, EaveSample[]>();
  for (const smp of support.samples) {
    const list = bySample.get(smp.edge);
    if (list === undefined) bySample.set(smp.edge, [smp]);
    else list.push(smp);
  }

  const labelAt = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    if (c < 0 || r < 0 || c >= g.w || r >= g.h) return -1;
    return labels[r * g.w + c]!;
  };
  // Bilinear height between pixel centres (NaN when a corner has none).
  const bilinear = (x: number, y: number): number => {
    const fc = x / s - 0.5;
    const fr = -y / s - 0.5;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    if (c < 0 || r < 0 || c + 1 >= g.w || r + 1 >= g.h) return NaN;
    const tx = fc - c;
    const ty = fr - r;
    const i = r * g.w + c;
    return (dsm[i]! * (1 - tx) + dsm[i + 1]! * tx) * (1 - ty) + (dsm[i + g.w]! * (1 - tx) + dsm[i + g.w + 1]! * tx) * ty;
  };

  // Each edge: direction, outward normal, owning face, and whether it is that face's eave.
  type EdgeInfo = { a: XY; b: XY; len: number; d: XY; nOut: XY; face: number; eave: boolean; steep: boolean; samples: EaveSample[] };
  const eaveCos = Math.cos((p.eaveDeg * Math.PI) / 180);
  const minSlope = p.minPitchX12 / 12;
  const edges: EdgeInfo[] = ring.map((a, k) => {
    const b = ring[(k + 1) % ring.length]!;
    const len = dist(a, b);
    const d = len > 0 ? { x: (b.x - a.x) / len, y: (b.y - a.y) / len } : { x: 1, y: 0 };
    const nOut = { x: d.y, y: -d.x };
    const samples = bySample.get(k) ?? [];
    const votes = new Map<number, number>();
    for (const smp of samples) {
      const f = labelAt(smp.x - nOut.x * p.insetM, smp.y - nOut.y * p.insetM);
      if (f >= 0 && f < planes.length) votes.set(f, (votes.get(f) ?? 0) + 1);
    }
    let face = -1;
    let best = 0;
    for (const [f, v] of [...votes.entries()].sort((x, y) => x[0] - y[0])) {
      if (v > best) {
        best = v;
        face = f;
      }
    }
    if (best < 0.5 * samples.length) face = -1;
    let eave = false;
    let steep = false;
    if (face >= 0) {
      const pl = planes[face]!;
      const slope = Math.hypot(pl.a, pl.b);
      steep = slope >= minSlope;
      // Level direction of the plane is (-b, a) / slope: |cos| to the edge.
      eave = slope > 0 && Math.abs((d.x * -pl.b + d.y * pl.a) / slope) >= eaveCos;
    }
    return { a, b, len, d, nOut, face, eave, steep, samples };
  });

  // 1. Eave heights: per face, from its strongly supported eave samples, at the steepest drop across the edge.
  const values: number[][] = planes.map(() => []);
  for (const e of edges) {
    if (e.face < 0 || !e.eave || !e.steep) continue;
    const pl = planes[e.face]!;
    for (const smp of e.samples) {
      if (smp.support !== 'strong') continue;
      // The drop's centre across the edge: the centroid of the height's fall beyond the plane's own slope. A blurred step
      // falls over a plateau as wide as the blur, and the steepest point of it sits at the plateau's inner end where the
      // plane's slope adds to it; the centroid is the step's middle wherever the blur is symmetric.
      const half = Math.max(p.descentHalfM, 3 * s);
      const dt = s / 2;
      const planeFall = -(pl.a * e.nOut.x + pl.b * e.nOut.y);
      let wsum = 0;
      let tsum = 0;
      let gap = false;
      for (let t = -half; t <= half + 1e-9; t += dt) {
        const z0 = bilinear(smp.x + e.nOut.x * (t - dt), smp.y + e.nOut.y * (t - dt));
        const z1 = bilinear(smp.x + e.nOut.x * (t + dt), smp.y + e.nOut.y * (t + dt));
        const fall = -(z1 - z0) / (2 * dt) - planeFall;
        if (!Number.isFinite(fall)) {
          gap = true;
          break;
        }
        if (fall > 0) {
          wsum += fall;
          tsum += fall * t;
        }
      }
      if (gap || !(wsum > 0)) continue;
      const bestT = tsum / wsum;
      values[e.face]!.push(planeZ(pl, smp.x + e.nOut.x * bestT, smp.y + e.nOut.y * bestT));
    }
  }
  const own: (number | null)[] = values.map((v) => {
    if (v.length * step < p.minStrongM) return null;
    const m = median(v);
    const mad = median(v.map((x) => Math.abs(x - m)));
    return mad <= p.faceMadM ? m : null;
  });
  const faceStats = values.map((v) => {
    if (v.length === 0) return { n: 0, h: null, mad: null };
    const m = median(v);
    return { n: v.length, h: Math.round(m * 1000) / 1000, mad: Math.round(median(v.map((x) => Math.abs(x - m))) * 1000) / 1000 };
  });
  const known = own.filter((v): v is number => v !== null);
  const agree = known.length > 0 && Math.max(...known) - Math.min(...known) <= p.houseAgreeM;
  const house = known.length > 0 ? median(known) : null;
  const eaveHeights = own.map((v) => (v !== null ? v : agree ? house : null));


  // 2. Hidden edges, grouped into runs of consecutive hidden edges and the runs into pieces by face (an edge with no
  //    face joins the piece before it). A taller neighbour (a crown higher than the roof reads so when the photo
  //    misses it) is hidden too: a wall of another building is caught by the sweep's other-building test.
  const N = edges.length;
  const hiddenN = edges.map((e) => e.samples.filter((x) => x.support === 'none').length);
  const hiddenLen = edges.map((e, k) => (hiddenN[k]! * e.len) / Math.max(1, e.samples.length));
  const isHidden = edges.map((e, k) => e.samples.length > 0 && hiddenN[k]! / e.samples.length >= p.hiddenShare);
  const hiddenM = hiddenLen.reduce((t, x) => t + x, 0);
  type Piece = { edges: number[]; face: number };
  const pieces: Piece[] = [];
  if (isHidden.some((x) => x)) {
    // Start right after a visible edge so no run wraps round the start (at 0 when every edge is hidden).
    const start = isHidden.every((x) => x) ? 0 : (isHidden.findIndex((x) => !x) + 1) % N;
    let cur: Piece | null = null;
    for (let j = 0; j < N; j++) {
      const k = (start + j) % N;
      if (!isHidden[k]) {
        cur = null;
        continue;
      }
      const f = edges[k]!.face;
      if (cur !== null && (f < 0 || f === cur.face || cur.face < 0)) {
        cur.edges.push(k);
        if (cur.face < 0) cur.face = f;
      } else {
        cur = { edges: [k], face: f };
        pieces.push(cur);
      }
    }
  }

  // Pixels between the old outline and a new line, within the piece's extent along it: what the move adds (outside the
  // ring, inside the line) and removes (inside the ring, outside the line).
  const sweep = (line: Line, nOut: XY, u0: number, u1: number, pl: Plane, old: readonly XY[]) => {
    const pts = [...old, ...old.map((q) => ({ x: line.p.x + ((q.x - line.p.x) * line.d.x + (q.y - line.p.y) * line.d.y) * line.d.x, y: line.p.y + ((q.x - line.p.x) * line.d.x + (q.y - line.p.y) * line.d.y) * line.d.y }))];
    const c0 = Math.max(0, Math.floor(Math.min(...pts.map((q) => q.x)) / s) - 1);
    const c1 = Math.min(g.w - 1, Math.floor(Math.max(...pts.map((q) => q.x)) / s) + 1);
    const r0 = Math.max(0, Math.floor(-Math.max(...pts.map((q) => q.y)) / s) - 1);
    const r1 = Math.min(g.h - 1, Math.floor(-Math.min(...pts.map((q) => q.y)) / s) + 1);
    let added = 0;
    let ground = 0;
    let other = 0;
    let removed = 0;
    let onPlane = 0;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const q = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
        const u = (q.x - line.p.x) * line.d.x + (q.y - line.p.y) * line.d.y;
        if (u < u0 || u > u1) continue;
        const v = (q.x - line.p.x) * nOut.x + (q.y - line.p.y) * nOut.y;
        const inside = pointInRing(q, ring);
        if (inside === v <= 0) continue;
        const i = r * g.w + c;
        const z = dsm[i]!;
        const zp = planeZ(pl, q.x, q.y);
        if (!inside) {
          added++;
          if (input.other !== null && input.other[i] === 1) other++;
          if (Number.isFinite(z) && z < zp - p.yardDropM) ground++;
        } else {
          removed++;
          if (Number.isFinite(z) && Math.abs(z - zp) <= p.onPlaneM) onPlane++;
        }
      }
    }
    return { added, ground: added > 0 ? ground / added : 0, other, removed, onPlane: removed > 0 ? onPlane / removed : 0 };
  };

  // 3. Each piece: its face's eave line, if it passes every gate.
  const declined: Partial<Record<PlanesDecline, number>> = {};
  const reports: PlanesPiece[] = [];
  // line null: a chamfer dropped for the corner where its neighbours meet (step 3b).
  const proposals: { piece: Piece; line: Line | null; report: PlanesPiece; members?: number[] }[] = [];
  const maxNormal = (p.maxNormalDeg * Math.PI) / 180;
  let eligibleM = 0;
  for (const pc of pieces) {
    const first = pc.edges[0]!;
    const last = pc.edges.at(-1)!;
    const hm = pc.edges.reduce((t, k) => t + hiddenLen[k]!, 0);
    const pl = pc.face >= 0 ? planes[pc.face]! : null;
    const slope = pl === null ? 0 : Math.hypot(pl.a, pl.b);
    const rep: PlanesPiece = { first, last, face: pc.face, pitchX12: pl === null ? null : Math.round(slope * 1200) / 100, hiddenM: r3(hm), outcome: 'replaced' };
    reports.push(rep);
    const no = (why: PlanesDecline) => {
      rep.outcome = why;
      declined[why] = (declined[why] ?? 0) + 1;
    };
    if (pl === null) {
      no('no-face');
      continue;
    }
    if (slope < minSlope) {
      no('low-pitch');
      continue;
    }
    const h = eaveHeights[pc.face]!;
    if (h !== null) eligibleM += hm;
    if (hm < p.minHiddenM) {
      no('short');
      continue;
    }
    // The piece's outward direction: its edges' outward normals weighted by length.
    let nx = 0;
    let ny = 0;
    for (const k of pc.edges) {
      nx += edges[k]!.nOut.x * edges[k]!.len;
      ny += edges[k]!.nOut.y * edges[k]!.len;
    }
    const nl = Math.hypot(nx, ny);
    const down = { x: -pl.a / slope, y: -pl.b / slope };
    const normalAng = nl > 0 ? Math.acos(Math.max(-1, Math.min(1, (nx * down.x + ny * down.y) / nl))) : Math.PI;
    rep.normalDeg = Math.round((normalAng * 180) / Math.PI);
    if (normalAng > maxNormal) {
      no('not-eave');
      continue;
    }
    if (h === null) {
      no(known.length > 0 && !agree ? 'split-level' : 'no-eave-height');
      continue;
    }
    // The eave line: through the foot of the gradient from the piece's first corner, along the level direction (with the
    // ring's direction: the face's downhill side is on the right of travel, the ring being counter-clockwise).
    const a0 = ring[first]!;
    const t = (h - planeZ(pl, a0.x, a0.y)) / (slope * slope);
    const line: Line = { p: { x: a0.x + t * pl.a, y: a0.y + t * pl.b }, d: { x: -down.y, y: down.x } };
    // Every corner of the piece (its first to its last + 1), as an outward offset to the line.
    const corners = [...pc.edges.map((k) => ring[k]!), ring[(last + 1) % N]!];
    const offs = corners.map((q) => (planeZ(pl, q.x, q.y) - h) / slope);
    rep.minOffsetM = r3(Math.min(...offs));
    rep.maxOffsetM = r3(Math.max(...offs));
    // The piece's two end corners are rebuilt where the line meets its neighbours (bounded by maxCornerMoveM there), so
    // only the corners between them bound how far out the line may run.
    const inner = offs.slice(1, -1);
    if (
      rep.minOffsetM < p.minOffsetM ||
      (inner.length > 0 && Math.max(...inner) > p.maxOffsetM) ||
      Math.min(offs[0]!, offs.at(-1)!) > p.maxOffsetM ||
      rep.maxOffsetM > p.maxEndOffsetM
    ) {
      no('offset');
      continue;
    }
    const seen = pc.edges.flatMap((k) => edges[k]!.samples.filter((x) => x.support !== 'none'));
    if (seen.length >= 5 && median(seen.map((q) => Math.abs((planeZ(pl, q.x, q.y) - h) / slope))) > p.visibleAgreeM) {
      no('disagrees-visible');
      continue;
    }
    const us = corners.map((q) => (q.x - line.p.x) * line.d.x + (q.y - line.p.y) * line.d.y);
    const sw = sweep(line, down, Math.min(...us), Math.max(...us), pl, corners);
    if (sw.other > 0) {
      no('other-building');
      continue;
    }
    if (sw.ground > p.yardShare) {
      no('yard-visible');
      continue;
    }
    if (sw.removed * s * s >= 0.5 && sw.onPlane > p.onPlaneShare) {
      no('roof-visible');
      continue;
    }
    proposals.push({ piece: pc, line, report: rep });
  }

  // 3b. Hidden chamfers: consecutive pieces that are no face's eave (a crown's diagonal cut across a hip corner), at most
  //     chamferMaxM long in all, proposed for dropping. They are kept only where the two lines either side then meet on
  //     their planes' crease as two eaves (step 4), sweeping no visible yard.
  const nPieces = reports.length;
  for (let i = 0; i < nPieces; i++) {
    if (reports[i]!.outcome !== 'not-eave') continue;
    const group = [i];
    while (group.length < pieces.length) {
      const j = (group.at(-1)! + 1) % nPieces;
      if (j === i || reports[j]!.outcome !== 'not-eave' || reports[j]!.first !== (reports[group.at(-1)!]!.last + 1) % N) break;
      group.push(j);
    }
    // Only the start of a group (not one already inside the group before it).
    const before = (i + nPieces - 1) % nPieces;
    if (group.length < nPieces && reports[before]!.outcome === 'not-eave' && (reports[before]!.last + 1) % N === reports[i]!.first && before !== i) continue;
    const ks = group.flatMap((j) => pieces[j]!.edges);
    if (ks.length >= N - 2 || ks.reduce((t, k) => t + edges[k]!.len, 0) > p.chamferMaxM) continue;
    const r0 = reports[group[0]!]!;
    const rep: PlanesPiece = { first: r0.first, last: reports[group.at(-1)!]!.last, face: -1, pitchX12: null, hiddenM: r3(ks.reduce((t, k) => t + hiddenLen[k]!, 0)), outcome: 'replaced' };
    proposals.push({ piece: { edges: ks, face: -1 }, line: null, report: rep, members: group });
    reports.push(rep);
  }

  // The face whose steep eave a kept edge is (-1 when it is none: a rake, a low face, no face).
  const eaveFace = (k: number): number => {
    const e = edges[k]!;
    return e.face >= 0 && e.eave && e.steep ? e.face : -1;
  };
  // 4. The ring rebuilt with a set of pieces replaced: every kept edge keeps its line, a replaced piece is one line, and
  //    neighbouring lines meet where they cross (or, nearly parallel, in a jog through the old corner).
  type Built = { ring: XY[]; corners: { a: number; b: number; at: XY }[]; drops: { chain: XY[]; at: XY; a: number; b: number }[]; bad: boolean };
  const build = (chosen: readonly (typeof proposals)[number][]): Built | null => {
    const byFirst = new Map(chosen.map((c) => [c.piece.edges[0]!, c]));
    const inPiece = new Set(chosen.flatMap((c) => c.piece.edges));
    type Item = { line: Line; first: number; pc: (typeof proposals)[number] | null; afterDrop: (typeof proposals)[number] | null };
    const items: Item[] = [];
    let drop: (typeof proposals)[number] | null = null;
    for (let k = 0; k < N; k++) {
      const c = byFirst.get(k);
      if (c !== undefined && c.line === null) drop = c;
      else if (c !== undefined) {
        items.push({ line: c.line!, first: k, pc: c, afterDrop: drop });
        drop = null;
      } else if (!inPiece.has(k)) {
        items.push({ line: { p: edges[k]!.a, d: edges[k]!.d }, first: k, pc: null, afterDrop: drop });
        drop = null;
      }
    }
    // A drop wrapping past the last edge belongs before the first item.
    if (drop !== null && items.length > 0) items[0]!.afterDrop = drop;
    if (items.length < 3) return null;
    const out: XY[] = [];
    const corners: Built['corners'] = [];
    const drops: Built['drops'] = [];
    let bad = false;
    const faceOf = (q: Item) => (q.pc !== null ? q.pc.piece.face : eaveFace(q.first));
    for (let j = 0; j < items.length; j++) {
      const it = items[j]!;
      const pv = items[(j + items.length - 1) % items.length]!;
      const at = ring[it.first]!;
      const turn = Math.acos(Math.min(1, Math.abs(it.line.d.x * pv.line.d.x + it.line.d.y * pv.line.d.y)));
      const x = turn > (10 * Math.PI) / 180 ? intersectLines(pv.line, it.line) : null;
      const fa = faceOf(pv);
      const fb = faceOf(it);
      if (it.afterDrop !== null) {
        // A dropped chamfer: its neighbours must meet as two eaves of different faces.
        if (x === null || fa < 0 || fb < 0 || fa === fb || dist(x, at) > p.maxCornerMoveM) {
          bad = true;
          out.push(at);
          continue;
        }
        out.push(x);
        corners.push({ a: fa, b: fb, at: x });
        const chain = it.afterDrop.piece.edges.map((k) => ring[k]!);
        drops.push({ chain: [...chain, at], at: x, a: fa, b: fb });
        continue;
      }
      if (x !== null && dist(x, at) <= p.maxCornerMoveM) {
        out.push(x);
        // A replaced piece meeting another face's eave (replaced or kept) meets it on their planes' crease.
        if ((it.pc !== null || pv.pc !== null) && fa >= 0 && fb >= 0 && fa !== fb) corners.push({ a: fa, b: fb, at: x });
        continue;
      }
      const proj = (l: Line): XY => {
        const u = (at.x - l.p.x) * l.d.x + (at.y - l.p.y) * l.d.y;
        return { x: l.p.x + u * l.d.x, y: l.p.y + u * l.d.y };
      };
      const a1 = proj(pv.line);
      const a2 = proj(it.line);
      out.push(a1);
      if (dist(a1, a2) > 1e-6) out.push(a2);
    }
    return { ring: out, corners, drops, bad };
  };
  const sound = (b: ReturnType<typeof build>): PlanesDecline | null => {
    if (b !== null && b.bad) return 'no-corner';
    if (b === null || b.ring.length < 3 || selfIntersects(b.ring) || !(signedArea(b.ring) > 0)) return 'self-intersects';
    if (Math.abs(signedArea(b.ring) - area0) > p.maxAreaChange * area0) return 'large-change';
    for (const q of b.ring) {
      let near = Infinity;
      for (const o of ring) near = Math.min(near, dist(q, o));
      if (near > p.maxCornerMoveM + 1e-9) return 'large-change';
    }
    // Two eave lines of different faces meet on (the extension of) their planes' crease: |zi - zj| / |grad (zi - zj)|.
    for (const c of b.corners) {
      const pi = planes[c.a]!;
      const pj = planes[c.b]!;
      const gd = Math.hypot(pi.a - pj.a, pi.b - pj.b);
      if (gd < 1e-9 || Math.abs(planeZ(pi, c.at.x, c.at.y) - planeZ(pj, c.at.x, c.at.y)) / gd > p.creaseTolM) return 'no-corner';
    }
    // A dropped chamfer's corner may not sweep visible yard or another building (judged on the lower plane there).
    for (const d of b.drops) {
      const poly = [...d.chain, d.at];
      const lower = planeZ(planes[d.a]!, d.at.x, d.at.y) <= planeZ(planes[d.b]!, d.at.x, d.at.y) ? planes[d.a]! : planes[d.b]!;
      const xs = poly.map((q) => q.x);
      const ys = poly.map((q) => q.y);
      let added = 0;
      let ground = 0;
      for (let r = Math.max(0, Math.floor(-Math.max(...ys) / s)); r <= Math.min(g.h - 1, Math.floor(-Math.min(...ys) / s)); r++) {
        for (let c = Math.max(0, Math.floor(Math.min(...xs) / s)); c <= Math.min(g.w - 1, Math.floor(Math.max(...xs) / s)); c++) {
          const q = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
          if (!pointInRing(q, poly) || pointInRing(q, ring)) continue;
          const i = r * g.w + c;
          if (input.other !== null && input.other[i] === 1) return 'other-building';
          added++;
          const z = dsm[i]!;
          if (Number.isFinite(z) && z < planeZ(lower, q.x, q.y) - p.yardDropM) ground++;
        }
      }
      if (added > 0 && ground / added > p.yardShare) return 'yard-visible';
    }
    return null;
  };

  // 5. Pieces accepted one at a time, the most hidden outline first; each kept only when the ring stays sound.
  const order = [...proposals].sort((x, y) => y.report.hiddenM - x.report.hiddenM || x.report.first - y.report.first);
  const accepted: (typeof proposals)[number][] = [];
  for (const c of order) {
    const why = sound(build([...accepted, c]));
    if (why !== null) {
      // A chamfer that cannot be dropped stays declined as not-eave (counted already; its own report says why).
      c.report.outcome = why;
      if (c.members === undefined) declined[why] = (declined[why] ?? 0) + 1;
      continue;
    }
    accepted.push(c);
    // A dropped chamfer's pieces are no longer declined.
    for (const j of c.members ?? []) {
      declined['not-eave'] = (declined['not-eave'] ?? 1) - 1;
      if (declined['not-eave'] <= 0) delete declined['not-eave'];
      reports[j]!.outcome = 'replaced';
    }
  }
  const outline = accepted.length > 0 ? build(accepted)!.ring : ring.map((q) => ({ ...q }));
  const changes: PlanesChange[] = accepted
    .map((c) => ({ first: c.report.first, last: c.report.last, face: c.piece.face, hiddenM: c.report.hiddenM, minOffsetM: c.report.minOffsetM ?? 0, maxOffsetM: c.report.maxOffsetM ?? 0 }))
    .sort((x, y) => x.first - y.first);
  return {
    ok: true,
    outline,
    changes,
    declined,
    eaveHeights: eaveHeights.map((v) => (v === null ? null : r3(v))),
    hiddenM: r3(hiddenM),
    eligibleM: r3(eligibleM),
    replacedM: r3(changes.reduce((t, c) => t + c.hiddenM, 0)),
    faceStats,
    pieces: reports,
  };
}
