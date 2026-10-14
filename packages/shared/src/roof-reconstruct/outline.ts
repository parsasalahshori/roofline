// The roof's outline: the pixel boundary of the roof, simplified to straight edges and squared to the house: edges
// within SNAP_DEG of the house's two main directions are turned onto them, each edge is refitted to the boundary it
// stands for, edges that end up in line are merged, a jog between two parallel edges gets its own short edge, and the
// corners are rebuilt where neighbouring edges cross. Falls back to the plain simplified boundary when squaring would
// change the shape too much.
import { dist, fitLine, intersectLines, type Line, nearestOnSegment, selfIntersects, signedArea, simplifyClosedIdx, type XY } from './geom.ts';
import { lattice, traceCycles } from './lattice.ts';
import type { Grid, Mask } from './raster.ts';

export type OutlineParams = {
  /** Douglas-Peucker tolerance on the pixel boundary, metres. */
  simplifyM: number;
  /** Edges within this many degrees of the house's main directions are snapped to them. */
  snapDeg: number;
  /** Neighbouring edges whose lines are this close (metres) and parallel are one edge. */
  mergeOffsetM: number;
  /** Squared edges shorter than this are dropped (their neighbours meet instead), metres. */
  minEdgeM: number;
  /** A slanted edge shorter than this between two square edges is a clipped corner, metres. */
  chamferM: number;
  /** Slanted edges shorter than this in a row, all within zigzagOffM of one line, are that one line, metres. */
  zigzagM: number;
  zigzagOffM: number;
};

export const DEFAULT_OUTLINE_PARAMS: OutlineParams = { simplifyM: 0.3, snapDeg: 12, mergeOffsetM: 0.3, minEdgeM: 0.25, chamferM: 1.5, zigzagM: 3, zigzagOffM: 0.7 };

/** The outer pixel boundary of a mask (one region), as a counter-clockwise ring of lattice corners in metres. */
export function maskBoundary(g: Grid, m: Mask, s: number): XY[] {
  const labels = new Int32Array(m.length);
  for (let i = 0; i < m.length; i++) labels[i] = m[i] === 1 ? 1 : -1;
  const L = lattice(g, labels);
  const cycles = traceCycles(L, 1);
  let best: XY[] = [];
  let bestArea = 0;
  for (const cyc of cycles) {
    const ring = cyc.verts.map((v) => ({ x: (v % L.vw) * s, y: -Math.floor(v / L.vw) * s }));
    const a = signedArea(ring);
    if (a > bestArea) {
      bestArea = a;
      best = ring;
    }
  }
  return dropStraight(best);
}

/** Drops corners where the boundary runs straight on. */
function dropStraight(ring: XY[]): XY[] {
  const out: XY[] = [];
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const a = ring[(k + n - 1) % n]!;
    const b = ring[k]!;
    const c = ring[(k + 1) % n]!;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  return out;
}

/** The house's main direction (radians, 0 to pi/2): the length-squared weighted mean of edge directions, mod 90 degrees. */
export function mainAxis(ring: readonly XY[]): number {
  let cs = 0;
  let sn = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const phi = Math.atan2(b.y - a.y, b.x - a.x);
    cs += len2 * Math.cos(4 * phi);
    sn += len2 * Math.sin(4 * phi);
  }
  const axis = Math.atan2(sn, cs) / 4;
  return ((axis % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
}

type Edge = { line: Line; pts: XY[]; snapped: boolean };

/** The edge's line refitted to its boundary points (direction kept when snapped). */
function refit(pts: XY[], dir: XY, snapped: boolean): Line {
  if (!snapped) {
    const l = fitLine(pts);
    if (l !== null) {
      const flip = l.d.x * dir.x + l.d.y * dir.y < 0;
      return { p: l.p, d: flip ? { x: -l.d.x, y: -l.d.y } : l.d };
    }
  }
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  return { p: { x: mx / pts.length, y: my / pts.length }, d: dir };
}

function angleBetween(a: XY, b: XY): number {
  return Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y)));
}

function offsetBetween(l1: Line, l2: Line): number {
  // Distance from l2's point to l1's line.
  return Math.abs((l2.p.x - l1.p.x) * l1.d.y - (l2.p.y - l1.p.y) * l1.d.x);
}

/** Squares a counter-clockwise ring (the pixel boundary). Returns the squared ring, or the simplified one when squaring fails. */
export function squareOutline(boundary: readonly XY[], prm: OutlineParams = DEFAULT_OUTLINE_PARAMS): XY[] {
  if (boundary.length < 3) return [...boundary];
  const keep = simplifyClosedIdx(boundary, prm.simplifyM);
  const simple = keep.map((k) => boundary[k]!);
  if (simple.length < 3) return [...boundary];
  const axis = mainAxis(simple);
  const snap = (prm.snapDeg * Math.PI) / 180;
  // 1. Edges: each simplified edge with the boundary points it stands for, snapped when near the main directions.
  let edges: Edge[] = [];
  for (let k = 0; k < keep.length; k++) {
    const i0 = keep[k]!;
    const i1 = keep[(k + 1) % keep.length]!;
    const pts: XY[] = [];
    for (let i = i0; ; i = (i + 1) % boundary.length) {
      pts.push(boundary[i]!);
      if (i === i1) break;
    }
    const a = boundary[i0]!;
    const b = boundary[i1]!;
    const len = dist(a, b);
    if (len < 1e-9) continue;
    const phi = Math.atan2(b.y - a.y, b.x - a.x);
    let rel = (phi - axis) % (Math.PI / 2);
    if (rel < 0) rel += Math.PI / 2;
    if (rel > Math.PI / 4) rel -= Math.PI / 2;
    const snapped = Math.abs(rel) <= snap;
    const ang = snapped ? phi - rel : phi;
    const dir = { x: Math.cos(ang), y: Math.sin(ang) };
    edges.push({ line: refit(pts, dir, snapped), pts, snapped });
  }
  // 2. Merge neighbouring edges that are in line; give a jog between parallel edges its own edge.
  for (let changed = true, guard = 0; changed && guard < 200 && edges.length > 3; guard++) {
    changed = false;
    for (let k = 0; k < edges.length && edges.length > 3; k++) {
      const e1 = edges[k]!;
      const e2 = edges[(k + 1) % edges.length]!;
      const ang = angleBetween(e1.line.d, e2.line.d);
      const parallel = e1.snapped && e2.snapped ? ang < 1e-3 : ang < (8 * Math.PI) / 180;
      if (!parallel) continue;
      if (offsetBetween(e1.line, e2.line) < prm.mergeOffsetM) {
        const pts = [...e1.pts, ...e2.pts];
        const longer = dist(e1.pts[0]!, e1.pts.at(-1)!) >= dist(e2.pts[0]!, e2.pts.at(-1)!) ? e1 : e2;
        const snapped = e1.snapped && e2.snapped;
        const merged: Edge = { line: refit(pts, longer.line.d, snapped), pts, snapped };
        if (k === edges.length - 1) edges = [merged, ...edges.slice(1, -1)];
        else edges.splice(k, 2, merged);
        changed = true;
        break;
      }
    }
  }
  // A zig-zag (two or more short slanted edges in a row, from trees or a ragged mask) that stays close to one straight
  // line is that line: one edge, squared when it runs near a main direction.
  for (let changed = true, guard = 0; changed && guard < 50 && edges.length > 3; guard++) {
    changed = false;
    const short = (e: Edge) => !e.snapped && dist(e.pts[0]!, e.pts.at(-1)!) < prm.zigzagM;
    for (let k = 0; k < edges.length && !changed; k++) {
      if (!short(edges[k]!) || short(edges[(k + edges.length - 1) % edges.length]!)) continue;
      let end = k;
      while (end - k + 1 < edges.length - 2 && short(edges[(end + 1) % edges.length]!)) end++;
      if (end === k) continue;
      const run = Array.from({ length: end - k + 1 }, (_, j) => edges[(k + j) % edges.length]!);
      const pts = run.flatMap((e) => e.pts);
      const line = fitLine(pts);
      if (line === null) continue;
      const far = Math.max(...pts.map((p) => Math.abs((p.x - line.p.x) * line.d.y - (p.y - line.p.y) * line.d.x)));
      if (far > prm.zigzagOffM) continue;
      const a = pts[0]!;
      const b = pts.at(-1)!;
      const phi = Math.atan2(b.y - a.y, b.x - a.x);
      let rel = (phi - axis) % (Math.PI / 2);
      if (rel < 0) rel += Math.PI / 2;
      if (rel > Math.PI / 4) rel -= Math.PI / 2;
      const snapped = Math.abs(rel) <= snap;
      const ang = snapped ? phi - rel : phi;
      const merged: Edge = { line: refit(pts, { x: Math.cos(ang), y: Math.sin(ang) }, snapped), pts, snapped };
      const count = run.length;
      if (k + count <= edges.length) edges.splice(k, count, merged);
      else {
        const wrap = k + count - edges.length;
        edges = [merged, ...edges.slice(wrap, k)];
      }
      changed = true;
    }
  }
  // A short slanted edge between two square edges is a rounded or clipped corner in the mask (a tree, a gutter):
  // drop it, and the square edges meet in a corner.
  for (let k = 0; k < edges.length && edges.length > 3; ) {
    const e = edges[k]!;
    const prev = edges[(k + edges.length - 1) % edges.length]!;
    const next = edges[(k + 1) % edges.length]!;
    const chord = dist(e.pts[0]!, e.pts.at(-1)!);
    if (!e.snapped && chord < prm.chamferM && prev.snapped && next.snapped && angleBetween(prev.line.d, next.line.d) > Math.PI / 3) {
      edges.splice(k, 1);
      continue;
    }
    k++;
  }
  const withJogs: Edge[] = [];
  for (let k = 0; k < edges.length; k++) {
    const e1 = edges[k]!;
    const e2 = edges[(k + 1) % edges.length]!;
    withJogs.push(e1);
    if (angleBetween(e1.line.d, e2.line.d) < (15 * Math.PI) / 180) {
      // A step between two parallel edges: a short edge across, through the corner between them.
      const at = e2.pts[0]!;
      const d = { x: -e1.line.d.y, y: e1.line.d.x };
      withJogs.push({ line: { p: at, d }, pts: [at], snapped: e1.snapped });
    }
  }
  edges = withJogs;
  // 3. Corners where neighbouring edges cross; drop edges that come out too short or turned round, and try again.
  let ring: XY[] = [];
  for (let guard = 0; guard < 60 && edges.length >= 3; guard++) {
    ring = [];
    let bad = -1;
    for (let k = 0; k < edges.length; k++) {
      const prev = edges[(k + edges.length - 1) % edges.length]!;
      const p = intersectLines(prev.line, edges[k]!.line);
      if (p === null) {
        bad = k;
        break;
      }
      ring.push(p);
    }
    if (bad < 0) {
      for (let k = 0; k < edges.length; k++) {
        const a = ring[k]!;
        const b = ring[(k + 1) % ring.length]!;
        const d = edges[k]!.line.d;
        const along = (b.x - a.x) * d.x + (b.y - a.y) * d.y;
        if (along < prm.minEdgeM) {
          bad = k;
          break;
        }
      }
    }
    if (bad < 0) break;
    edges.splice(bad, 1);
    ring = [];
  }
  if (ring.length >= 3 && acceptable(ring, boundary)) return ring;
  return simple;
}

/** The squared ring is kept only when it is simple, about the same area, and never far from the pixel boundary. */
function acceptable(ring: readonly XY[], boundary: readonly XY[]): boolean {
  const a = signedArea(ring);
  const b = signedArea(boundary);
  if (!(a > 0) || Math.abs(a - b) > 0.08 * b) return false;
  if (selfIntersects(ring)) return false;
  for (const p of boundary) {
    let best = Infinity;
    for (let k = 0; k < ring.length; k++) best = Math.min(best, nearestOnSegment(p, ring[k]!, ring[(k + 1) % ring.length]!).d);
    if (best > 0.8) return false;
  }
  return true;
}
