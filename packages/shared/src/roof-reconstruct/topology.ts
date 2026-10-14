// Roof topology from the face label image: a planar graph whose nodes are the corners where three or more faces (or
// two faces and the roof's edge) meet, and whose chains are the boundaries between two faces or a face and the edge.
// - Chains shorter than a minimum are contracted (two faces that touch only briefly are not neighbours), merging their
//   end nodes into one corner where all their faces meet.
// - A boundary between two faces is a crease (the straight intersection of their planes) unless the planes are far
//   apart in height there (a step: a wall between a higher and a lower roof).
// - Each corner is placed where the lines of its creases (and steps) cross, in a least-squares sense (three planes
//   meeting give their exact common point); a corner on the roof's edge is placed on the squared outline.
// - Each face's polygon is walked round its boundary: straight between corners along a crease, along the step's
//   simplified path, and along the outline between edge corners. Every crease therefore runs corner to corner and
//   neighbouring faces share their corners exactly.
import { dist, fitLine, intersectLines, type Line, nearestOnSegment, pathLength, selfIntersects, signedArea, simplifyIdx, type XY } from './geom.ts';
import { type Cycle, lattice, type Lattice, traceCycles } from './lattice.ts';
import { planeZ, type Plane } from './planes.ts';
import type { Grid } from './raster.ts';

export type RoofLineKind3d = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake' | 'step' | 'flat-edge';

export type TopologyParams = {
  /** Two faces sharing less boundary than this (metres) only touch at a corner. */
  minSharedM: number;
  /** A face touching the outline for less than this (metres) only touches it at a corner. */
  minEdgeM: number;
  /** A boundary is a step when the planes are this far apart in height there (and their crease is elsewhere), metres. */
  stepM: number;
  /** A crease climbing less than this (degrees) is level: a ridge rather than a hip. */
  levelDeg: number;
  /** An outline edge within this angle (degrees) of its face's level direction is an eave; steeper, a rake. */
  eaveDeg: number;
  /** Below this slope (x/12) a face is flat (low slope). */
  flatX12: number;
  /** A corner within this of an outline corner is moved onto it, metres. */
  cornerSnapM: number;
};

export const DEFAULT_TOPOLOGY_PARAMS: TopologyParams = {
  minSharedM: 0.8,
  minEdgeM: 1.0,
  stepM: 0.4,
  levelDeg: 6,
  eaveDeg: 30,
  flatX12: 2,
  cornerSnapM: 0.6,
};

export type TopoFace = { ring: XY[]; areaM2: number; fromPixels: boolean };
export type TopoLine = { kind: RoofLineKind3d; a: XY; b: XY; faces: number[]; lengthM: number; riseM: number };
export type Topology = { faces: TopoFace[]; lines: TopoLine[] };

type Chain = {
  /** Lattice vertexes, start node first, end node last (equal for a loop). */
  verts: number[];
  left: number;
  right: number;
  start: number;
  end: number;
  loop: boolean;
};

class UnionFind {
  private parent: number[] = [];
  add(): number {
    this.parent.push(this.parent.length);
    return this.parent.length - 1;
  }
  find(a: number): number {
    while (this.parent[a] !== a) {
      this.parent[a] = this.parent[this.parent[a]!]!;
      a = this.parent[a]!;
    }
    return a;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** The incident cracks of a lattice vertex, as directions whose crack is a boundary. */
function boundaryDirs(L: Lattice, i: number, j: number): number[] {
  const p = (r: number, c: number) => (r < 0 || c < 0 || r >= L.g.h || c >= L.g.w ? -1 : L.labels[r * L.g.w + c]!);
  const out: number[] = [];
  if (j < L.g.w && p(i - 1, j) !== p(i, j)) out.push(0);
  if (i > 0 && p(i - 1, j - 1) !== p(i - 1, j)) out.push(1);
  if (j > 0 && p(i - 1, j - 1) !== p(i, j - 1)) out.push(2);
  if (i < L.g.h && p(i, j - 1) !== p(i, j)) out.push(3);
  return out;
}

const DI = [0, -1, 0, 1];
const DJ = [1, 0, -1, 0];

function sidesOf(L: Lattice, i: number, j: number, d: number): [number, number] {
  const p = (r: number, c: number) => (r < 0 || c < 0 || r >= L.g.h || c >= L.g.w ? -1 : L.labels[r * L.g.w + c]!);
  switch (d) {
    case 0:
      return [p(i - 1, j), p(i, j)];
    case 2:
      return [p(i, j - 1), p(i - 1, j - 1)];
    case 3:
      return [p(i, j), p(i, j - 1)];
    default:
      return [p(i - 1, j - 1), p(i - 1, j)];
  }
}

/** Chains between nodes (vertexes where three or more boundary cracks meet), and loops with no node. */
function traceChains(L: Lattice): { chains: Chain[]; chainOfCode: Int32Array; nodeVerts: Set<number> } {
  const { g, vw } = L;
  const nodeVerts = new Set<number>();
  for (let i = 0; i <= g.h; i++) for (let j = 0; j <= g.w; j++) if (boundaryDirs(L, i, j).length >= 3) nodeVerts.add(i * vw + j);
  const chainOfCode = new Int32Array(L.crackCount * 2).fill(-1);
  const chains: Chain[] = [];
  const codeOf = (i: number, j: number, d: number): number => {
    switch (d) {
      case 0:
        return (i * g.w + j) * 2;
      case 2:
        return (i * g.w + j - 1) * 2 + 1;
      case 3:
        return (L.hCount + i * (g.w + 1) + j) * 2;
      default:
        return (L.hCount + (i - 1) * (g.w + 1) + j) * 2 + 1;
    }
  };
  const walk = (i0: number, j0: number, d0: number) => {
    const code0 = codeOf(i0, j0, d0);
    if (chainOfCode[code0]! >= 0) return;
    const id = chains.length;
    const [left, right] = sidesOf(L, i0, j0, d0);
    const verts = [i0 * vw + j0];
    let i = i0;
    let j = j0;
    let d = d0;
    for (let guard = 0; guard < 4 * L.crackCount; guard++) {
      const code = codeOf(i, j, d);
      chainOfCode[code] = id;
      chainOfCode[code ^ 1] = id;
      i += DI[d]!;
      j += DJ[d]!;
      const v = i * vw + j;
      verts.push(v);
      if (nodeVerts.has(v)) break;
      // A pass-through corner has exactly two boundary cracks: go on along the other one.
      const back = (d + 2) % 4;
      const next = boundaryDirs(L, i, j).find((x) => x !== back);
      if (next === undefined) break;
      d = next;
    }
    const start = verts[0]!;
    const end = verts.at(-1)!;
    chains.push({ verts, left, right, start, end, loop: start === end });
  };
  for (const v of nodeVerts) {
    const i = Math.floor(v / vw);
    const j = v % vw;
    for (const d of boundaryDirs(L, i, j)) walk(i, j, d);
  }
  // Loops with no node on them: start anywhere.
  for (let i = 0; i <= g.h; i++) {
    for (let j = 0; j < g.w; j++) {
      const code = (i * g.w + j) * 2;
      if (chainOfCode[code]! >= 0) continue;
      const [a, b] = sidesOf(L, i, j, 0);
      if (a === b) continue;
      nodeVerts.add(i * vw + j);
      walk(i, j, 0);
    }
  }
  return { chains, chainOfCode, nodeVerts };
}

/** A face's boundary cycles as runs of whole chains: [chain, forward (the face is the chain's left)]. */
function runsOf(cycle: Cycle, chainOfCode: Int32Array, chains: Chain[], face: number): [number, boolean][] {
  const n = cycle.codes.length;
  const ids = cycle.codes.map((c) => chainOfCode[c]!);
  // Rotate so the cycle starts where a chain starts (at a node).
  let start = 0;
  for (let k = 0; k < n; k++) {
    if (ids[k] !== ids[(k + n - 1) % n]) {
      start = k;
      break;
    }
  }
  const runs: [number, boolean][] = [];
  for (let k = 0; k < n; k++) {
    const id = ids[(start + k) % n]!;
    if (runs.length > 0 && runs.at(-1)![0] === id) continue;
    runs.push([id, chains[id]!.left === face]);
  }
  if (runs.length > 1 && runs[0]![0] === runs.at(-1)![0]) runs.pop();
  return runs;
}

/** The point on a closed polyline nearest p, as its arc-length position and the point. */
function onRing(ring: readonly XY[], p: XY): { t: number; q: XY; d: number; seg: number } {
  let best = { t: 0, q: ring[0]!, d: Infinity, seg: 0 };
  let acc = 0;
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    const r = nearestOnSegment(p, a, b);
    if (r.d < best.d) best = { t: acc + r.t * dist(a, b), q: r.q, d: r.d, seg: k };
    acc += dist(a, b);
  }
  return best;
}

/** The outline's corners strictly between arc positions t0 and t1 going forward (counter-clockwise), then the end point. */
function alongRing(ring: readonly XY[], perim: number, cum: readonly number[], t0: number, t1: number, endPoint: XY): XY[] {
  const span = (((t1 - t0) % perim) + perim) % perim;
  const between: { rel: number; p: XY }[] = [];
  for (let k = 0; k < ring.length; k++) {
    const rel = (((cum[k]! - t0) % perim) + perim) % perim;
    if (rel > 1e-6 && rel < span - 1e-6) between.push({ rel, p: ring[k]! });
  }
  between.sort((a, b) => a.rel - b.rel);
  return [...between.map((o) => o.p), endPoint];
}

function lineBetween(p: Plane, q: Plane): { line: Line; strength: number } | null {
  const A = p.a - q.a;
  const B = p.b - q.b;
  const C = p.c - q.c;
  const g = Math.hypot(A, B);
  if (g < 1e-4) return null;
  // A x + B y + C = 0
  const n = { x: A / g, y: B / g };
  const at = { x: (-C / g) * n.x, y: (-C / g) * n.y };
  return { line: { p: at, d: { x: -n.y, y: n.x } }, strength: g };
}

function distToLine(p: XY, l: Line): number {
  return Math.abs((p.x - l.p.x) * l.d.y - (p.y - l.p.y) * l.d.x);
}

/**
 * The roof's faces (polygons) and lines from the face label image (-1 outside the roof), the faces' planes and the
 * squared outline (counter-clockwise). `pixelArea[k]` is face k's area by pixels (the fallback and the check).
 */
export function buildTopology(
  g: Grid,
  s: number,
  labels: Int32Array,
  planes: readonly Plane[],
  outline: readonly XY[],
  dsm: Float32Array,
  prm: TopologyParams = DEFAULT_TOPOLOGY_PARAMS,
  debug?: (msg: string) => void,
): Topology {
  const L = lattice(g, labels);
  const { vw } = L;
  const nFaces = planes.length;
  const at = (v: number): XY => ({ x: (v % vw) * s, y: -Math.floor(v / vw) * s });
  const { chains, chainOfCode } = traceChains(L);
  const flat = planes.map((p) => Math.hypot(p.a, p.b) * 12 < prm.flatX12);

  // Nodes: one per node vertex, merged along contracted chains.
  const uf = new UnionFind();
  const nodeOfVert = new Map<number, number>();
  const nodeOf = (v: number) => {
    let id = nodeOfVert.get(v);
    if (id === undefined) {
      id = uf.add();
      nodeOfVert.set(v, id);
    }
    return id;
  };
  for (const c of chains) {
    nodeOf(c.start);
    nodeOf(c.end);
  }
  const contracted = chains.map((c) => {
    if (c.loop) return false;
    const chord = dist(at(c.start), at(c.end));
    const outside = c.left < 0 || c.right < 0;
    const limit = outside ? prm.minEdgeM : prm.minSharedM;
    return chord < limit && c.verts.length * s < 2.5 * limit;
  });
  chains.forEach((c, k) => {
    if (contracted[k]) uf.union(nodeOf(c.start), nodeOf(c.end));
  });
  const root = (v: number) => uf.find(nodeOf(v));

  // Each root node: the pixel position (mean of its vertexes), whether it is on the outline, its chains.
  const members = new Map<number, XY[]>();
  for (const [v] of nodeOfVert) {
    const r = root(v);
    const list = members.get(r) ?? [];
    list.push(at(v));
    members.set(r, list);
  }
  const p0 = new Map<number, XY>();
  for (const [r, list] of members) p0.set(r, { x: list.reduce((t, p) => t + p.x, 0) / list.length, y: list.reduce((t, p) => t + p.y, 0) / list.length });
  const onEdge = new Set<number>();
  const incident = new Map<number, number[]>();
  chains.forEach((c, k) => {
    if (contracted[k]) return;
    for (const v of c.loop ? [c.start] : [c.start, c.end]) {
      const r = root(v);
      const list = incident.get(r) ?? [];
      list.push(k);
      incident.set(r, list);
      if (c.left < 0 || c.right < 0) onEdge.add(r);
    }
  });

  // Chain kinds: outline; crease (its planes' straight intersection); step (a wall: the height map jumps across the
  // boundary and the planes are far apart in height there); seam (neither: planes that barely differ, no line drawn).
  type Kind = { type: 'outline' } | { type: 'crease'; line: Line; strength: number } | { type: 'step' } | { type: 'seam' };
  const dsmAt = (x: number, y: number): number => {
    // Bilinear height at a point (pixel centres at ((c + 0.5) s, -(r + 0.5) s)); NaN off the grid.
    const fc = x / s - 0.5;
    const fr = -y / s - 0.5;
    const c = Math.floor(fc);
    const r = Math.floor(fr);
    if (c < 0 || r < 0 || c + 1 >= g.w || r + 1 >= g.h) return Number.NaN;
    const tx = fc - c;
    const ty = fr - r;
    const v = (rr: number, cc: number) => dsm[rr * g.w + cc]!;
    return (v(r, c) * (1 - tx) + v(r, c + 1) * tx) * (1 - ty) + (v(r + 1, c) * (1 - tx) + v(r + 1, c + 1) * tx) * ty;
  };
  const kinds: Kind[] = chains.map((c, k) => {
    if (c.left < 0 || c.right < 0) return { type: 'outline' };
    if (contracted[k]) return { type: 'seam' };
    const pi = planes[c.left]!;
    const pj = planes[c.right]!;
    const pts = c.verts.map(at);
    // A low quantile, not the median: a tree or a chimney on part of the boundary does not make it a wall.
    const median = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length * 0.3)] ?? 0;
    const gap = median(pts.map((p) => Math.abs(planeZ(pi, p.x, p.y) - planeZ(pj, p.x, p.y))));
    // The wall test: across the boundary, the most the height map climbs over a short window, beyond what the
    // steeper of the two planes climbs there.
    const half = Math.max(1, Math.round(0.5 / s));
    const every = Math.max(1, Math.round(0.3 / s));
    const win = 0.3;
    const maxSlope = Math.max(Math.hypot(pi.a, pi.b), Math.hypot(pj.a, pj.b));
    const excess: number[] = [];
    for (let v = half; v + half < pts.length; v += every) {
      const a = pts[v - half]!;
      const b = pts[v + half]!;
      const len = dist(a, b);
      if (len < 1e-9) continue;
      const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
      const p = pts[v]!;
      const prof: number[] = [];
      for (let t = -0.6; t <= 0.6 + 1e-9; t += s) prof.push(dsmAt(p.x + t * n.x, p.y + t * n.y));
      const w = Math.max(1, Math.round(win / s));
      let jump = 0;
      for (let q = 0; q + w < prof.length; q++) {
        const d = Math.abs(prof[q + w]! - prof[q]!);
        if (Number.isFinite(d)) jump = Math.max(jump, d);
      }
      excess.push(jump - win * maxSlope);
    }
    const wall = excess.length > 0 ? median(excess) : 0;
    const lb = lineBetween(pi, pj);
    const off = lb === null ? Infinity : median(pts.map((p) => distToLine(p, lb.line)));
    debug?.(`chain ${k} faces ${c.left}/${c.right} len ${(c.verts.length * s).toFixed(1)} gap ${gap.toFixed(2)} off ${off.toFixed(2)} wall ${wall.toFixed(2)} strength ${lb?.strength.toFixed(2)}`);
    if (gap > prm.stepM && wall > prm.stepM * 0.75) return { type: 'step' };
    if (lb !== null && lb.strength >= 0.05 && off <= 3) return { type: 'crease', line: lb.line, strength: lb.strength };
    return gap >= 0.25 ? { type: 'step' } : { type: 'seam' };
  });

  // Outline arc positions.
  const perim = pathLength([...outline, outline[0]!]);
  const cum: number[] = [];
  {
    let acc = 0;
    for (let k = 0; k < outline.length; k++) {
      cum.push(acc);
      acc += dist(outline[k]!, outline[(k + 1) % outline.length]!);
    }
  }

  // Place the nodes.
  const pos = new Map<number, XY>();
  const chainNearLine = (k: number, r: number): Line | null => {
    // The step's direction near this node: a line fitted on its points within 2 m of the node.
    const pts = chains[k]!.verts.map(at);
    const here = p0.get(r)!;
    const near = pts.filter((p) => dist(p, here) <= 2);
    const l = fitLine(near.length >= 4 ? near : pts);
    return l !== null && pathLength(near.length >= 4 ? near : pts) >= 0.5 ? l : null;
  };
  const constraintsOf = (r: number) => {
    const creases: { line: Line; w: number; chain: number }[] = [];
    const steps: Line[] = [];
    for (const k of incident.get(r) ?? []) {
      const kind = kinds[k]!;
      if (kind.type === 'crease') creases.push({ line: kind.line, w: Math.min(1, kind.strength / 0.25) ** 2, chain: k });
      else if (kind.type === 'step' || kind.type === 'seam') {
        const l = chainNearLine(k, r);
        if (l !== null) steps.push(l);
      }
    }
    return { creases, steps };
  };
  // Inside corners first: least squares on their crease and step lines, held lightly to the pixel corner.
  for (const [r, start] of p0) {
    if (onEdge.has(r)) continue;
    const { creases, steps } = constraintsOf(r);
    const lam = 0.05;
    let a11 = lam;
    let a12 = 0;
    let a22 = lam;
    let b1 = lam * start.x;
    let b2 = lam * start.y;
    const add = (l: Line, w: number) => {
      const n = { x: -l.d.y, y: l.d.x };
      const d = n.x * l.p.x + n.y * l.p.y;
      a11 += w * n.x * n.x;
      a12 += w * n.x * n.y;
      a22 += w * n.y * n.y;
      b1 += w * n.x * d;
      b2 += w * n.y * d;
    };
    for (const c of creases) add(c.line, c.w);
    for (const l of steps) add(l, 1);
    const det = a11 * a22 - a12 * a12;
    let p = start;
    if (Math.abs(det) > 1e-12) p = { x: (b1 * a22 - b2 * a12) / det, y: (b2 * a11 - b1 * a12) / det };
    pos.set(r, dist(p, start) > 1.5 ? start : p);
  }
  // Then corners on the outline: where a crease from a placed inside corner first reaches the outline (trees and
  // clutter at the roof's edge move the pixel corner, not the crease); else where a crease crosses the outline nearest
  // the pixel corner; else the pixel corner moved onto the outline.
  const hits = (line: Line): { x: XY; t: number }[] => {
    const out: { x: XY; t: number }[] = [];
    for (let e = 0; e < outline.length; e++) {
      const a = outline[e]!;
      const b = outline[(e + 1) % outline.length]!;
      const len = dist(a, b);
      if (len < 1e-9) continue;
      const x = intersectLines(line, { p: a, d: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } });
      if (x === null) continue;
      const along = ((x.x - a.x) * (b.x - a.x) + (x.y - a.y) * (b.y - a.y)) / (len * len);
      if (along < -0.02 || along > 1.02) continue;
      out.push({ x, t: (x.x - line.p.x) * line.d.x + (x.y - line.p.y) * line.d.y });
    }
    return out;
  };
  for (const [r, start] of p0) {
    if (!onEdge.has(r)) continue;
    const { creases } = constraintsOf(r);
    let best: XY | null = null;
    let bestD = Infinity;
    for (const c of creases) {
      const ch = chains[c.chain]!;
      const other = root(ch.start) === r ? root(ch.end) : root(ch.start);
      const from = pos.get(other);
      if (other === r || from === undefined || onEdge.has(other)) continue;
      // The ray from the inside corner along the crease, towards this corner.
      const toward = (start.x - from.x) * c.line.d.x + (start.y - from.y) * c.line.d.y >= 0 ? 1 : -1;
      const ray: Line = { p: from, d: { x: c.line.d.x * toward, y: c.line.d.y * toward } };
      const first = hits(ray).filter((h) => h.t > 0.05).sort((a, b) => a.t - b.t)[0];
      if (first === undefined) continue;
      const d = dist(first.x, start);
      if (d < bestD && d < 8) {
        bestD = d;
        best = first.x;
      }
    }
    if (best === null) {
      bestD = 4;
      for (const c of creases) {
        for (const h of hits(c.line)) {
          const d = dist(h.x, start);
          if (d < bestD) {
            bestD = d;
            best = h.x;
          }
        }
      }
    }
    const placed = onRing(outline, best ?? start).q;
    // Onto an outline corner when close (hips run into the corners).
    let snapped = placed;
    let cd = prm.cornerSnapM;
    for (const corner of outline) {
      const d = dist(corner, placed);
      if (d < cd) {
        cd = d;
        snapped = corner;
      }
    }
    pos.set(r, snapped);
  }

  // Corners on the outline keep the order their pixel corners have along it: a crease cast past its neighbouring corner
  // (a corner of the outline where another roof joins, say) puts that corner back where its pixels are.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    chains.forEach((c, k) => {
      if (contracted[k] || c.loop || kinds[k]!.type !== 'outline') return;
      const ru = root(c.left >= 0 ? c.start : c.end);
      const rv = root(c.left >= 0 ? c.end : c.start);
      if (ru === rv) return;
      const span = (((onRing(outline, pos.get(rv)!).t - onRing(outline, pos.get(ru)!).t) % perim) + perim) % perim;
      if (span <= 1.6 * c.verts.length * s + 2) return;
      const shift = (r: number) => dist(pos.get(r)!, onRing(outline, p0.get(r)!).q);
      const r = shift(ru) >= shift(rv) ? ru : rv;
      const back = onRing(outline, p0.get(r)!).q;
      if (dist(back, pos.get(r)!) < 1e-6) return;
      pos.set(r, back);
      moved = true;
    });
    if (!moved) break;
  }

  // Each chain's path (in its own forward direction), corner to corner.
  const paths: XY[][] = chains.map((c, k) => {
    const kind = kinds[k]!;
    const a = pos.get(root(c.start))!;
    const b = pos.get(root(c.end))!;
    if (kind.type === 'outline') {
      if (c.loop) return [...outline, outline[0]!];
      // With the face on the left the chain runs counter-clockwise round the outline; the other way otherwise.
      const faceLeft = c.left >= 0;
      const [from, to] = faceLeft ? [a, b] : [b, a];
      const t0 = onRing(outline, from).t;
      const t1 = onRing(outline, to).t;
      let path = [from, ...alongRing(outline, perim, cum, t0, t1, to)];
      const pixelLen = c.verts.length * s;
      if (pathLength(path) > 1.6 * pixelLen + 2) path = [from, to];
      return faceLeft ? path : path.reverse();
    }
    if (kind.type === 'crease' || contracted[k]) return [a, b];
    const pts = c.verts.map(at);
    const keep = simplifyIdx(pts, 0.25).map((i) => pts[i]!);
    return [a, ...keep.slice(1, -1), b];
  });

  // Faces: walk each face's boundary cycles. A step whose pixel path makes a face's polygon cross itself is
  // straightened (corner to corner) and the walk is done again; a face still unsound falls back to its own pixels.
  const walkFaces = (): { faces: TopoFace[]; badSteps: Set<number> } => {
    const visited = new Uint8Array(L.crackCount * 2);
    const out: TopoFace[] = [];
    const badSteps = new Set<number>();
    for (let f = 0; f < nFaces; f++) {
      const cycles = traceCycles(L, f, visited);
      const rings: XY[][] = [];
      const pixelRings: XY[][] = [];
      const steps: number[] = [];
      for (const cyc of cycles) {
        pixelRings.push(cyc.verts.map(at));
        const ring: XY[] = [];
        for (const [k, fwd] of runsOf(cyc, chainOfCode, chains, f)) {
          if (contracted[k] && !chains[k]!.loop) continue;
          if (kinds[k]!.type === 'step' || kinds[k]!.type === 'seam') steps.push(k);
          const path = fwd ? paths[k]! : [...paths[k]!].reverse();
          for (const p of path) if (ring.length === 0 || dist(ring.at(-1)!, p) > 1e-6) ring.push(p);
        }
        while (ring.length > 1 && dist(ring[0]!, ring.at(-1)!) < 1e-6) ring.pop();
        rings.push(ring);
      }
      const pixelArea = pixelRings.reduce((t, r) => t + signedArea(r), 0);
      const outer = rings.map((r, i) => ({ r, a: signedArea(r), pa: signedArea(pixelRings[i]!) })).filter((x) => x.pa > 0);
      const holes = rings.filter((_, i) => signedArea(pixelRings[i]!) < 0);
      const main = outer.sort((x, y) => y.pa - x.pa)[0];
      let ring = main?.r ?? [];
      const area = (main?.a ?? 0) + holes.reduce((t, h) => t + signedArea(h), 0);
      const ok =
        ring.length >= 3 && area > 0 && !selfIntersects(ring) && area > 0.6 * pixelArea && area < 1.6 * pixelArea && holes.every((h) => h.length >= 3);
      if (ok) {
        for (const h of holes) ring = bridge(ring, h);
        out.push({ ring, areaM2: area, fromPixels: false });
      } else {
        debug?.(`face ${f} ring unsound: ${ring.length} corners, area ${area.toFixed(1)} vs pixels ${pixelArea.toFixed(1)}, crosses ${selfIntersects(ring)}, rings ${rings.length} holes ${holes.length}: ${ring.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}`);
        for (const k of steps) badSteps.add(k);
        // The walk did not give a sound polygon: the face's own pixel boundary, simplified.
        const px = pixelRings.map((r) => ({ r, a: signedArea(r) })).sort((x, y) => y.a - x.a)[0]?.r ?? [];
        const keep = px.length > 4 ? simplifyIdx([...px, px[0]!], 0.15).slice(0, -1).map((i) => px[i]!) : px;
        out.push({ ring: keep, areaM2: pixelArea, fromPixels: true });
      }
    }
    return { faces: out, badSteps };
  };
  let walked = walkFaces();
  const straighten = [...walked.badSteps].filter((k) => paths[k]!.length > 2);
  if (straighten.length > 0) {
    for (const k of straighten) paths[k] = [paths[k]![0]!, paths[k]!.at(-1)!];
    walked = walkFaces();
  }
  const faces = walked.faces;

  // Lines.
  const lines: TopoLine[] = [];
  const levelTan = Math.tan((prm.levelDeg * Math.PI) / 180);
  const eaveCos = Math.cos((prm.eaveDeg * Math.PI) / 180);
  chains.forEach((c, k) => {
    if (contracted[k]) return;
    const kind = kinds[k]!;
    const path = paths[k]!;
    if (kind.type === 'outline') {
      const f = c.left >= 0 ? c.left : c.right;
      const pl = planes[f]!;
      const slope = Math.hypot(pl.a, pl.b);
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]!;
        const b = path[i]!;
        const len = dist(a, b);
        if (len < 0.05) continue;
        const rise = Math.abs(planeZ(pl, b.x, b.y) - planeZ(pl, a.x, a.y));
        let lk: RoofLineKind3d = 'flat-edge';
        if (!flat[f]) {
          // Level direction of the face: across its slope.
          const lx = -pl.b / slope;
          const ly = pl.a / slope;
          const cos = Math.abs(((b.x - a.x) * lx + (b.y - a.y) * ly) / len);
          lk = cos >= eaveCos ? 'eave' : 'rake';
        }
        lines.push({ kind: lk, a, b, faces: [f], lengthM: Math.hypot(len, rise), riseM: rise });
      }
      return;
    }
    if (kind.type === 'seam') return;
    const i = c.left;
    const j = c.right;
    const pi = planes[i]!;
    const pj = planes[j]!;
    if (kind.type === 'step') {
      for (let n = 1; n < path.length; n++) {
        const a = path[n - 1]!;
        const b = path[n]!;
        const len = dist(a, b);
        if (len < 0.05) continue;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const lower = planeZ(pi, mid.x, mid.y) <= planeZ(pj, mid.x, mid.y) ? pi : pj;
        const rise = Math.abs(planeZ(lower, b.x, b.y) - planeZ(lower, a.x, a.y));
        lines.push({ kind: 'step', a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise });
      }
      return;
    }
    const a = path[0]!;
    const b = path.at(-1)!;
    const len = dist(a, b);
    if (len < 0.3) return;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const rise = Math.abs(planeZ(pi, b.x, b.y) - planeZ(pi, a.x, a.y));
    let lk: RoofLineKind3d;
    if (flat[i] || flat[j]) lk = 'flat-edge';
    else {
      // Into the left face: the chain's left, so (-uy, ux) from its forward direction.
      const nx = -uy;
      const ny = ux;
      const convex = (pj.a - pi.a) * nx + (pj.b - pi.b) * ny > 0;
      const climb = Math.abs(pi.a * ux + pi.b * uy);
      lk = convex ? (climb < levelTan ? 'ridge' : 'hip') : 'valley';
    }
    lines.push({ kind: lk, a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise });
  });
  return { faces, lines };
}

/** A ring with a hole joined in through a zero-width cut from the hole's corner nearest the ring. */
function bridge(ring: XY[], hole: XY[]): XY[] {
  let bi = 0;
  let bj = 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    for (let j = 0; j < hole.length; j++) {
      const d = dist(ring[i]!, hole[j]!);
      if (d < best) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  const h = [...hole.slice(bj), ...hole.slice(0, bj), hole[bj]!];
  return [...ring.slice(0, bi + 1), ...h, ...ring.slice(bi)];
}
