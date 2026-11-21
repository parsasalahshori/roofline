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

/**
 * Ridge, hip and valley: creases between two faces. Eave and rake: a face's edge, on the outline or over a lower roof.
 * Flashing and step flashing: where a lower roof meets a wall rising above it. Flat edge: where two flat faces meet.
 * Pitch break: where one face runs on into another sloping the same way at nearly the same pitch (no edge of either).
 */
export type RoofLineKind3d = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake' | 'flashing' | 'step-flashing' | 'flat-edge' | 'pitch-break';

export type TopologyParams = {
  /** Two faces sharing less boundary than this (metres) only touch at a corner. */
  minSharedM: number;
  /** A face touching the outline for less than this (metres) only touches it at a corner. */
  minEdgeM: number;
  /** A boundary is a step when the planes are this far apart in height there (and their crease is elsewhere), metres. */
  stepM: number;
  /** A crease climbing less than this (degrees) is level: a ridge rather than a hip. */
  levelDeg: number;
  /**
   * Two faces falling away from their crease on opposite sides (their downhill directions at least this far apart,
   * degrees) meet in a ridge even when the fitted planes make it climb a little: a hip is between faces about square
   * to each other.
   */
  ridgeFacingDeg: number;
  /**
   * A face drains onto (or away from) a crease when its slope across the crease is at least this share of its own
   * slope (and at least `drainMinSlope`, rise over run); less, and the crease runs up the face.
   */
  drainShare: number;
  drainMinSlope: number;
  /**
   * Where an upper face drains onto a lower one along a line within `ontoEaveDeg` of level on the upper face: faces
   * within `breakFacingDeg` of the same downhill direction and `breakX12` of the same pitch run on into each other (a
   * pitch break, no edge); otherwise the upper face ends there in an eave (a report counts it: the main roof's eave
   * over a porch roof, a dormer's over the roof below). A line climbing more than that across the upper face is a hip
   * or a valley (by the planes), as a report counts it: on the benchmark's EagleView houses, making every same-way
   * pair a pitch break whatever the line's direction lost real hips and valleys between faces whose fitted planes
   * came out alike.
   */
  ontoEaveDeg: number;
  breakFacingDeg: number;
  breakX12: number;
  /**
   * A face's edge within this angle (degrees) of its level direction is an eave (or, along a wall, flashing); steeper,
   * a rake (step flashing). 45: whichever it is nearer, so a cut-off corner of a hip roof's eave stays an eave.
   */
  eaveDeg: number;
  /**
   * A wall runs within this angle (degrees) of a face's level or slope direction; a height break on the diagonal across
   * both faces' slopes is a hip or valley the height map holds apart.
   */
  wallDeg: number;
  /** Below this slope (x/12) a face is flat (low slope). */
  flatX12: number;
  /** Below this slope (x/12) a face is dead level: every edge of it is an eave. */
  levelX12: number;
  /** A corner within this of an outline corner is moved onto it, metres. */
  cornerSnapM: number;
  /** A piece of a face's edge shorter than this between two longer pieces of one kind is a jog in it, metres. */
  jogM: number;
  /**
   * A face's edge is named by its plane (eave where it runs level along the face, rake where it climbs) unless the
   * height map beside the edge clearly says otherwise (`measuredEdge`). The pixels along a roof's edge are often another
   * face's than the roof behind them (a hip end merged into the main slope, a gable the planes missed, a corner placed a
   * little off), so the face's plane says rake along a real eave and eave along a real rake. Measured on the roof 0.6 to
   * 1.5 m in from the edge: how it climbs away from the edge, and how much it climbs or falls along it. The angle between
   * the two is the edge's angle from level on the roof that is really there: under `measuredEaveDeg` an edge the plane
   * calls a rake is an eave; at `measuredRakeDeg` or more an edge the plane calls an eave is a rake; between them the
   * plane stands. Not asked where the roof there is flatter than `measuredMinSlope` (rise over run) or the face is low
   * slope (the direction of next to no slope is noise), or the edge is too short to measure (about 1.3 m).
   * Fitted on the benchmark's EagleView houses (dev): of the edge length it renames, 12 ft in 13 is renamed right.
   */
  measuredEdge: boolean;
  measuredEaveDeg: number;
  measuredRakeDeg: number;
  measuredMinSlope: number;
  /**
   * A line the planes call an upper face's eave over a lower roof (a crease the upper face drains onto, or a wall under
   * it), where the height map falls away from the line on BOTH sides by at least `fallAwaySlope` (rise over run, 0.6 to
   * 1.5 m out) is a ridge (`measuredRidge`): the "upper" face's pixels there lie over the ridge, on roof its plane does
   * not describe. Along a wall the line must also be level in the height map (under `ridgeAlongSlope` along it).
   * On the benchmark's EagleView houses (dev) every foot this renames was not an eave, and two thirds are ridges.
   */
  measuredRidge: boolean;
  fallAwaySlope: number;
  ridgeAlongSlope: number;
  /**
   * A valley is a trough: the roof rises away from it on both sides. A crease the planes call a valley, where the
   * height map 1 m out on the lower face's side lies `valleyDropM` or more BELOW the line, is no trough: the lower roof
   * is a step down the planes smoothed over, and the line is the upper face's edge over it (eave or rake, as on a wall;
   * the lower face is flashed). 0 turns it off. On the benchmark's EagleView houses (dev) none of the length this
   * renames was a valley; it leaves the valley total short by what the reconstruction really misses (see
   * docs/roof-3d/line-kinds.md: wrong valleys used to make up for missing ones).
   */
  valleyDropM: number;
  /**
   * A hip is a crest: the roof falls away from it on both sides. A crease the planes call a hip that climbs the upper
   * face (it would be that face's rake), where the height map 1 m out on the upper face's side stands `hipStepM` or more
   * ABOVE the line, is the upper roof's rake over the lower roof (the lower face is step flashed). 0 turns it off.
   */
  hipStepM: number;
};

export const DEFAULT_TOPOLOGY_PARAMS: TopologyParams = {
  minSharedM: 0.8,
  minEdgeM: 1.0,
  stepM: 0.4,
  levelDeg: 6,
  ridgeFacingDeg: 135,
  drainShare: 0.25,
  drainMinSlope: 0.03,
  ontoEaveDeg: 25,
  breakFacingDeg: 30,
  breakX12: 2,
  eaveDeg: 45,
  wallDeg: 30,
  flatX12: 2,
  levelX12: 0.5,
  cornerSnapM: 0.6,
  jogM: 1.5,
  measuredEdge: true,
  measuredEaveDeg: 40,
  measuredRakeDeg: 75,
  measuredMinSlope: 0.1,
  measuredRidge: true,
  fallAwaySlope: 0.1,
  ridgeAlongSlope: 0.3,
  valleyDropM: 0.3,
  hipStepM: 0.6,
};

/**
 * Development only (roof3d:dump --features): what the topology knew about a line when it named it, for studying the
 * naming rules against an answer key. Never part of the stored roof. `left` and `right` are the faces on either side of
 * a -> b (-1 outside the roof); `v` holds the measurements (see `featuresOf` in buildTopology).
 */
export type LineFeatures = {
  src: 'outline' | 'step-edge' | 'step-wall' | 'crease' | 'seam';
  kind: RoofLineKind3d | 'none';
  a: XY;
  b: XY;
  left: number;
  right: number;
  chain: number;
  v: Record<string, number>;
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
  collect?: LineFeatures[],
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
  const chainStats: Record<string, number>[] = chains.map(() => ({}));
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
    if (collect !== undefined) chainStats[k] = { chainGap: gap, chainOff: Number.isFinite(off) ? off : 99, chainWall: wall, chainStrength: lb?.strength ?? 0 };
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
  // How far a direction (unit dx, dy) is from a face's level direction (across its slope), as |cos|: 1 level, 0 straight
  // up the slope; 1 on a dead-level face.
  const levelSlope = prm.levelX12 / 12;
  const levelCos = (f: number, dx: number, dy: number): number => {
    const pl = planes[f]!;
    const slope = Math.hypot(pl.a, pl.b);
    return slope < levelSlope ? 1 : Math.abs((dx * -pl.b + dy * pl.a) / slope);
  };
  const labelAt = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : labels[r * g.w + c]!;
  };
  const medianOf = (xs: number[]): number => {
    const ok = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return ok.length === 0 ? Number.NaN : ok[Math.floor(ok.length / 2)]!;
  };
  // The height map on the roof beside a line from a to b, on its left (side 1) or its right (-1), read at stations
  // every 0.4 m or so along the line (clear of its ends):
  // - `rise`: how the roof climbs away from the line between 0.6 and 1.5 m out (rise over run, the median over the
  //   stations; negative: it falls away). Clear of the first half metre, where the height map rounds a roof's edge off.
  // - `along`: how much it climbs or falls along the line 1 m out, whichever way (the median |slope| between stations
  //   about 1.2 m apart): a gable's edge climbs to the peak and falls again, an eave does neither.
  // NaN where it cannot be read: the line is too short (under about 1.3 m for `along`) or the roof beside it too narrow.
  const beside = (a: XY, b: XY, side: 1 | -1): { rise: number; along: number } => {
    const len = dist(a, b);
    if (len < 1e-6) return { rise: Number.NaN, along: Number.NaN };
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy * side;
    const ny = ux * side;
    const inset = Math.min(0.4, len / 4);
    const count = Math.max(1, Math.floor((len - 2 * inset) / 0.4) + 1);
    const ts: number[] = [];
    for (let q = 0; q < count; q++) ts.push(count === 1 ? len / 2 : inset + ((len - 2 * inset) * q) / (count - 1));
    const zAt = (t: number, d: number): number => {
      const x = a.x + ux * t + nx * d;
      const y = a.y + uy * t + ny * d;
      return labelAt(x, y) >= 0 ? dsmAt(x, y) : Number.NaN;
    };
    const rise = medianOf(ts.map((t) => (labelAt(a.x + ux * t + nx * 1.5, a.y + uy * t + ny * 1.5) >= 0 ? (dsmAt(a.x + ux * t + nx * 1.5, a.y + uy * t + ny * 1.5) - dsmAt(a.x + ux * t + nx * 0.6, a.y + uy * t + ny * 0.6)) / 0.9 : Number.NaN)));
    const zs = ts.map((t) => zAt(t, 1));
    const lag = Math.min(3, count - 1);
    const slopes: number[] = [];
    if (lag >= 1) for (let q = 0; q + lag < count; q++) if (ts[q + lag]! - ts[q]! > 0.5) slopes.push(Math.abs(zs[q + lag]! - zs[q]!) / (ts[q + lag]! - ts[q]!));
    return { rise, along: medianOf(slopes) };
  };
  // How far the height map 1 m out from a -> b on one side stands above (positive) or lies below the line itself, the
  // line's height being the mean of the two faces' planes there (the median over the stations; NaN off the grid).
  const standBeside = (i: number, j: number, a: XY, b: XY, side: 1 | -1): number => {
    const len = dist(a, b);
    if (len < 1e-6) return Number.NaN;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const inset = Math.min(0.4, len / 4);
    const count = Math.max(1, Math.floor((len - 2 * inset) / 0.4) + 1);
    const hs: number[] = [];
    for (let q = 0; q < count; q++) {
      const t = count === 1 ? len / 2 : inset + ((len - 2 * inset) * q) / (count - 1);
      const x = a.x + ux * t;
      const y = a.y + uy * t;
      hs.push(dsmAt(x - uy * side, y + ux * side) - (planeZ(planes[i]!, x, y) + planeZ(planes[j]!, x, y)) / 2);
    }
    return medianOf(hs);
  };
  // Development only: the measurements behind each line's name (LineFeatures), when asked for.
  const faceStats =
    collect === undefined
      ? null
      : (() => {
          const n = new Float64Array(nFaces);
          const sum = new Float64Array(nFaces);
          for (let i = 0; i < labels.length; i++) {
            const f = labels[i]!;
            if (f < 0) continue;
            const z = dsm[i]!;
            if (!Number.isFinite(z)) continue;
            const x = ((i % g.w) + 0.5) * s;
            const y = -(Math.floor(i / g.w) + 0.5) * s;
            n[f]!++;
            sum[f]! += Math.min(1, Math.abs(z - planeZ(planes[f]!, x, y)));
          }
          return { n, sum };
        })();
  const featuresOf = (a: XY, b: XY, left: number, right: number, k: number): Record<string, number> => {
    const len = dist(a, b);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const nx = -uy;
    const ny = ux;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const v: Record<string, number> = { lenM: len, chainLenM: chains[k]!.verts.length * s, ...chainStats[k] };
    // Stations along the line, clear of its ends.
    const inset = Math.min(0.4, len / 4);
    const count = Math.max(1, Math.floor((len - 2 * inset) / 0.4) + 1);
    const stations: { p: XY; t: number }[] = [];
    for (let q = 0; q < count; q++) {
      const t = count === 1 ? len / 2 : inset + ((len - 2 * inset) * q) / (count - 1);
      stations.push({ p: { x: a.x + ux * t, y: a.y + uy * t }, t });
    }
    const both = left >= 0 && right >= 0;
    const zRef = (p: XY): number => {
      if (both) return (planeZ(planes[left]!, p.x, p.y) + planeZ(planes[right]!, p.x, p.y)) / 2;
      return planeZ(planes[left >= 0 ? left : right]!, p.x, p.y);
    };
    v.h0 = medianOf(stations.map(({ p }) => dsmAt(p.x, p.y) - zRef(p)));
    const side = (tag: 'L' | 'R', f: number, sgn: 1 | -1) => {
      // The height map on this side, against the line's own height (the planes' there).
      for (const off of [0.3, 0.6, 1, 1.5, 2.5]) {
        v[`h${tag}${off * 10}`] = medianOf(stations.map(({ p }) => dsmAt(p.x + sgn * off * nx, p.y + sgn * off * ny) - zRef(p)));
      }
      v[`roof${tag}`] = stations.filter(({ p }) => labelAt(p.x + sgn * nx, p.y + sgn * ny) >= 0).length / stations.length;
      // Its measured slope along the line, 0.5 m in (least squares over the stations).
      if (stations.length >= 3) {
        const zs = stations.map(({ p, t }) => ({ t, z: dsmAt(p.x + sgn * 0.5 * nx, p.y + sgn * 0.5 * ny) })).filter((o) => Number.isFinite(o.z));
        if (zs.length >= 3) {
          const mt = zs.reduce((acc, o) => acc + o.t, 0) / zs.length;
          const mz = zs.reduce((acc, o) => acc + o.z, 0) / zs.length;
          const den = zs.reduce((acc, o) => acc + (o.t - mt) ** 2, 0);
          if (den > 1e-9) v[`along${tag}`] = zs.reduce((acc, o) => acc + (o.t - mt) * (o.z - mz), 0) / den;
        }
      }
      // And across it, between 0.3 and 0.9 m in (positive: this side rises away from the line).
      v[`across${tag}`] = medianOf(stations.map(({ p }) => (dsmAt(p.x + sgn * 0.9 * nx, p.y + sgn * 0.9 * ny) - dsmAt(p.x + sgn * 0.3 * nx, p.y + sgn * 0.3 * ny)) / 0.6));
      // The roof a little way in on this side: the plane through the height map there (least squares over 0.6 to 1.8 m
      // in), as its slope along the line and away from it.
      {
        let n = 0, st = 0, sd = 0, sz = 0, stt = 0, sdd = 0, std = 0, stz = 0, sdz = 0;
        const pts: { t: number; d: number; z: number }[] = [];
        for (const { p, t } of stations) {
          for (const d of [0.6, 0.9, 1.2, 1.5, 1.8]) {
            const x = p.x + sgn * d * nx;
            const y = p.y + sgn * d * ny;
            if (labelAt(x, y) < 0) continue;
            const z = dsmAt(x, y);
            if (!Number.isFinite(z)) continue;
            pts.push({ t, d, z });
          }
        }
        if (pts.length >= 6) {
          const mt = pts.reduce((acc, o) => acc + o.t, 0) / pts.length;
          const md = pts.reduce((acc, o) => acc + o.d, 0) / pts.length;
          const mz = pts.reduce((acc, o) => acc + o.z, 0) / pts.length;
          for (const o of pts) {
            const t = o.t - mt, d = o.d - md, z = o.z - mz;
            n++; st += t; sd += d; sz += z; stt += t * t; sdd += d * d; std += t * d; stz += t * z; sdz += d * z;
          }
          const det = stt * sdd - std * std;
          if (sdd > 1e-6) {
            // A short line has no spread along itself: the slope away from it alone.
            const p1 = det > 1e-6 && stt > 0.05 ? (stz * sdd - sdz * std) / det : 0;
            const q1 = det > 1e-6 && stt > 0.05 ? (sdz * stt - stz * std) / det : sdz / sdd;
            v[`locAlong${tag}`] = p1;
            v[`locAcross${tag}`] = q1;
            let ss = 0;
            for (const o of pts) ss += (o.z - mz - p1 * (o.t - mt) - q1 * (o.d - md)) ** 2;
            v[`locRms${tag}`] = Math.sqrt(ss / n);
            v[`locN${tag}`] = n;
          }
        }
      }
      // How much the height map climbs or falls along the line, whichever way (a gable's edge climbs to its peak and
      // falls again; an eave does neither), at three depths in: the median |slope| between stations about 1.2 m apart.
      for (const d of [0.6, 1, 1.5]) {
        const zs = stations.map(({ p, t }) => ({ t, z: labelAt(p.x + sgn * d * nx, p.y + sgn * d * ny) >= 0 ? dsmAt(p.x + sgn * d * nx, p.y + sgn * d * ny) : Number.NaN }));
        const lag = Math.min(3, zs.length - 1);
        const slopes: number[] = [];
        if (lag >= 1) for (let q = 0; q + lag < zs.length; q++) if (zs[q + lag]!.t - zs[q]!.t > 0.5) slopes.push(Math.abs(zs[q + lag]!.z - zs[q]!.z) / (zs[q + lag]!.t - zs[q]!.t));
        v[`absAlong${tag}${d * 10}`] = medianOf(slopes);
      }
      // And how it climbs away from the line between 0.6 and 1.5 m in (the median over the stations).
      v[`rise${tag}`] = medianOf(stations.map(({ p }) => (labelAt(p.x + sgn * 1.5 * nx, p.y + sgn * 1.5 * ny) >= 0 ? (dsmAt(p.x + sgn * 1.5 * nx, p.y + sgn * 1.5 * ny) - dsmAt(p.x + sgn * 0.6 * nx, p.y + sgn * 0.6 * ny)) / 0.9 : Number.NaN)));
      v[`riseDeep${tag}`] = medianOf(stations.map(({ p }) => (labelAt(p.x + sgn * 2.4 * nx, p.y + sgn * 2.4 * ny) >= 0 ? (dsmAt(p.x + sgn * 2.4 * nx, p.y + sgn * 2.4 * ny) - dsmAt(p.x + sgn * 1 * nx, p.y + sgn * 1 * ny)) / 1.4 : Number.NaN)));
      // The face that holds the roof 1 m in on this side (the pixels along the line itself can be another face's).
      {
        const votes = new Map<number, number>();
        for (const { p } of stations) {
          const l = labelAt(p.x + sgn * nx, p.y + sgn * ny);
          if (l >= 0) votes.set(l, (votes.get(l) ?? 0) + 1);
        }
        let best = -1;
        for (const [l, c] of votes) if (best < 0 || c > votes.get(best)! || (c === votes.get(best)! && l < best)) best = l;
        if (best >= 0) {
          const pb = planes[best]!;
          const sb = Math.hypot(pb.a, pb.b);
          v[`beh${tag}`] = best === f ? 1 : 0;
          v[`behShare${tag}`] = votes.get(best)! / stations.length;
          v[`behSlope${tag}`] = sb;
          v[`behLevelDeg${tag}`] = (Math.acos(Math.min(1, levelCos(best, ux, uy))) * 180) / Math.PI;
          v[`behG${tag}`] = sgn * (pb.a * nx + pb.b * ny);
          v[`behFit${tag}`] = medianOf(stations.map(({ p }) => dsmAt(p.x + sgn * nx, p.y + sgn * ny) - planeZ(pb, p.x + sgn * nx, p.y + sgn * ny)));
          v[`behArea${tag}`] = faceStats!.n[best]! * s * s;
          v[`behZ${tag}`] = planeZ(pb, mid.x, mid.y);
        }
      }
      const m = beside(a, b, sgn);
      v[`mRise${tag}`] = m.rise;
      v[`mAlong${tag}`] = m.along;
      if (f < 0) return;
      const pl = planes[f]!;
      const slope = Math.hypot(pl.a, pl.b);
      v[`slope${tag}`] = slope;
      v[`levelDeg${tag}`] = (Math.acos(Math.min(1, levelCos(f, ux, uy))) * 180) / Math.PI;
      // Uphill into the face from the line (positive: the face comes down to the line), and along it.
      v[`g${tag}`] = sgn * (pl.a * nx + pl.b * ny);
      v[`climb${tag}`] = pl.a * ux + pl.b * uy;
      v[`area${tag}`] = faceStats!.n[f]! * s * s;
      v[`resid${tag}`] = faceStats!.n[f]! > 0 ? faceStats!.sum[f]! / faceStats!.n[f]! : 0;
      v[`z${tag}`] = planeZ(pl, mid.x, mid.y);
      v[`own${tag}`] = stations.filter(({ p }) => labelAt(p.x + sgn * 0.5 * nx, p.y + sgn * 0.5 * ny) === f).length / stations.length;
      v[`fit${tag}`] = medianOf(stations.map(({ p }) => dsmAt(p.x + sgn * 0.6 * nx, p.y + sgn * 0.6 * ny) - planeZ(pl, p.x + sgn * 0.6 * nx, p.y + sgn * 0.6 * ny)));
    };
    side('L', left, 1);
    side('R', right, -1);
    if (both) {
      const pi = planes[left]!;
      const pj = planes[right]!;
      const si = Math.hypot(pi.a, pi.b);
      const sj = Math.hypot(pj.a, pj.b);
      const cos = si > 1e-6 && sj > 1e-6 ? (pi.a * pj.a + pi.b * pj.b) / (si * sj) : 1;
      v.facingDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
      v.gapMid = planeZ(pi, mid.x, mid.y) - planeZ(pj, mid.x, mid.y);
      v.gapA = planeZ(pi, a.x, a.y) - planeZ(pj, a.x, a.y);
      v.gapB = planeZ(pi, b.x, b.y) - planeZ(pj, b.x, b.y);
    }
    return v;
  };
  const note = (src: LineFeatures['src'], kind: LineFeatures['kind'], a: XY, b: XY, k: number): void => {
    if (collect === undefined || dist(a, b) < 0.05) return;
    const c = chains[k]!;
    collect.push({ src, kind, a, b, left: c.left, right: c.right, chain: k, v: featuresOf(a, b, c.left, c.right, k) });
  };
  // A face's own edge from a to b: an edge of the roof (`edge`: eave where it runs level along the face, rake where it
  // climbs; a low-slope face's edges too, as a report counts them), or where the face meets a wall rising above it (`wall`: flashing where the wall
  // runs level along the face, step flashing where it climbs). Its true length is along the face's plane.
  // `side`: which side of a -> b the face is on (1 its left, -1 its right), for the height map's say on an edge.
  const faceEdge = (f: number, a: XY, b: XY, role: 'edge' | 'wall', side: 1 | -1): TopoLine | null => {
    const len = dist(a, b);
    if (len < 0.05) return null;
    const pl = planes[f]!;
    const rise = Math.abs(planeZ(pl, b.x, b.y) - planeZ(pl, a.x, a.y));
    let level = levelCos(f, (b.x - a.x) / len, (b.y - a.y) / len) >= eaveCos;
    if (role === 'edge' && prm.measuredEdge && !flat[f]) {
      // The roof that is really beside the edge (TopologyParams.measuredEdge): its angle from level along the edge.
      const m = beside(a, b, side);
      if (Number.isFinite(m.rise) && Number.isFinite(m.along) && Math.hypot(m.rise, m.along) >= prm.measuredMinSlope) {
        const deg = (Math.atan2(m.along, Math.abs(m.rise)) * 180) / Math.PI;
        if (level && deg >= prm.measuredRakeDeg) level = false;
        else if (!level && deg < prm.measuredEaveDeg) level = true;
      }
    }
    const kind: RoofLineKind3d = role === 'wall' ? (level ? 'flashing' : 'step-flashing') : level ? 'eave' : 'rake';
    return { kind, a, b, faces: [f], lengthM: Math.hypot(len, rise), riseM: rise };
  };
  // Whether the height map falls away from a -> b on both sides (TopologyParams.measuredRidge).
  const peakBeside = (a: XY, b: XY): { left: { rise: number; along: number }; right: { rise: number; along: number }; both: boolean } => {
    const left = beside(a, b, 1);
    const right = beside(a, b, -1);
    return { left, right, both: left.rise < -prm.fallAwaySlope && right.rise < -prm.fallAwaySlope };
  };
  // A crease from a to b between face i (on its left) and face j, by which way each face drains there.
  // - Both fall away from it: a ridge (level, or the two faces opposite each other) or a hip.
  // - Both come down to it: a valley.
  // - One comes down to it and the other falls away from it (or is flat), along a line near level on the upper face:
  //   the upper face drains onto the lower one. That is the upper face's eave, as on the outline, unless the two slope
  //   the same way at nearly the same pitch (a pitch break).
  // - Otherwise (the crease climbs across the faces) by the planes: convex a hip or ridge, concave a valley, by the
  //   steeper face's climb, so a low-slope face beside a steep one still meets it in a hip or valley.
  // A flat edge between two flat faces. Its rise is the planes' (the mean of the two on a crease the planes do not
  // quite meet along).
  const ridgeCos = Math.cos((prm.ridgeFacingDeg * Math.PI) / 180);
  const breakCos = Math.cos((prm.breakFacingDeg * Math.PI) / 180);
  const ontoEaveCos = Math.cos((prm.ontoEaveDeg * Math.PI) / 180);
  const creaseLine = (i: number, j: number, a: XY, b: XY): TopoLine | null => {
    const pi = planes[i]!;
    const pj = planes[j]!;
    const len = dist(a, b);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const rise = (Math.abs(planeZ(pi, b.x, b.y) - planeZ(pi, a.x, a.y)) + Math.abs(planeZ(pj, b.x, b.y) - planeZ(pj, a.x, a.y))) / 2;
    let lk: RoofLineKind3d;
    if (flat[i] && flat[j]) lk = 'flat-edge';
    else {
      const si = Math.hypot(pi.a, pi.b);
      const sj = Math.hypot(pj.a, pj.b);
      // Uphill into each face from the crease (rise over run): positive, the face comes down to the crease. The left
      // face is on (-uy, ux) from the chain's forward direction.
      const gi = pi.a * -uy + pi.b * ux;
      const gj = -(pj.a * -uy + pj.b * ux);
      const ti = Math.max(prm.drainMinSlope, prm.drainShare * si);
      const tj = Math.max(prm.drainMinSlope, prm.drainShare * sj);
      const onto = (f: number, g: number, t: number) => !flat[f] && g > t;
      const off = (f: number, g: number, t: number) => flat[f] || g < -t;
      const upper = onto(i, gi, ti) && off(j, gj, tj) ? i : onto(j, gj, tj) && off(i, gi, ti) ? j : -1;
      const facing = si > 0 && sj > 0 ? (pi.a * pj.a + pi.b * pj.b) / (si * sj) : 0;
      if (upper >= 0 && levelCos(upper, ux, uy) >= ontoEaveCos) {
        // The planes say the upper face comes down to this line; where the height map falls away from it on that side
        // too, both sides fall away: a ridge the upper face's pixels lie over (TopologyParams.measuredRidge).
        if (prm.measuredRidge && beside(a, b, upper === i ? 1 : -1).rise < -prm.fallAwaySlope) lk = 'ridge';
        else if (!flat[i] && !flat[j] && facing >= breakCos && Math.abs(si - sj) * 12 < prm.breakX12) lk = 'pitch-break';
        else {
          const pu = planes[upper]!;
          const eaveRise = Math.abs(planeZ(pu, b.x, b.y) - planeZ(pu, a.x, a.y));
          return { kind: 'eave', a, b, faces: [upper], lengthM: Math.hypot(len, eaveRise), riseM: eaveRise };
        }
      } else {
        // Into the left face: the chain's left, so (-uy, ux) from its forward direction.
        const convex = gi + gj < 0;
        // How steeply it climbs on the steeper face (a low-slope face beside it hardly climbs anywhere).
        const climb = Math.max(Math.abs(pi.a * ux + pi.b * uy), Math.abs(pj.a * ux + pj.b * uy));
        const opposite = !flat[i] && !flat[j] && gi < -ti && gj < -tj && facing <= ridgeCos;
        lk = convex ? (climb < levelTan || opposite ? 'ridge' : 'hip') : 'valley';
      }
    }
    return { kind: lk, a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise };
  };
  const pushCrease = (i: number, j: number, a: XY, b: XY, k: number): void => {
    const l = creaseLine(i, j, a, b);
    if (l === null) return;
    // A valley with a step down beside it, or a hip with a step up, is the upper face's edge over the lower roof
    // (TopologyParams.valleyDropM, hipStepM): named as along a wall.
    if ((l.kind === 'valley' && prm.valleyDropM > 0) || (l.kind === 'hip' && prm.hipStepM > 0)) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const [upper, lower] = planeZ(planes[i]!, mid.x, mid.y) >= planeZ(planes[j]!, mid.x, mid.y) ? [i, j] : [j, i];
      const upperSide = upper === i ? 1 : -1;
      const stepped = l.kind === 'valley' ? standBeside(i, j, a, b, upperSide === 1 ? -1 : 1) <= -prm.valleyDropM : standBeside(i, j, a, b, upperSide) >= prm.hipStepM;
      const e = stepped ? faceEdge(upper, a, b, 'edge', upperSide) : null;
      if (e !== null && (l.kind === 'valley' || e.kind === 'rake')) {
        const w = faceEdge(lower, a, b, 'wall', upperSide === 1 ? -1 : 1);
        lines.push(e);
        note('step-edge', e.kind, a, b, k);
        if (w !== null) {
          lines.push(w);
          note('step-wall', w.kind, a, b, k);
        }
        return;
      }
    }
    lines.push(l);
    note('crease', l.kind, a, b, k);
  };
  // A wall stands along a house's walls, so it runs level along a face beside it or straight up its slope; a boundary
  // running across both faces' slopes on the diagonal is where they meet (a hip or a valley), not a wall, even where
  // the height map holds them apart.
  const wallCos = Math.cos((prm.wallDeg * Math.PI) / 180);
  const diagonalCos = Math.cos(((90 - prm.wallDeg) * Math.PI) / 180);
  const diagonal = (f: number, dx: number, dy: number): boolean => {
    const cos = levelCos(f, dx, dy);
    return !flat[f] && cos < wallCos && cos > diagonalCos;
  };
  chains.forEach((c, k) => {
    if (contracted[k]) return;
    const kind = kinds[k]!;
    const path = paths[k]!;
    if (kind.type === 'outline') {
      const f = c.left >= 0 ? c.left : c.right;
      const pieces: TopoLine[] = [];
      for (let n = 1; n < path.length; n++) {
        const l = faceEdge(f, path[n - 1]!, path[n]!, 'edge', c.left >= 0 ? 1 : -1);
        if (l !== null) pieces.push(l);
      }
      const named = jogsFollow(pieces, prm.jogM);
      lines.push(...named);
      for (const l of named) note('outline', l.kind, l.a, l.b, k);
      return;
    }
    if (kind.type === 'seam') {
      if (path.length >= 2) note('seam', 'none', path[0]!, path.at(-1)!, k);
      return;
    }
    const i = c.left;
    const j = c.right;
    const pi = planes[i]!;
    const pj = planes[j]!;
    if (kind.type === 'step') {
      // A wall between a higher and a lower roof: the higher roof's edge over the lower one is its eave or rake (as an
      // edge on the outline would be), and where the lower roof meets the wall it is flashed.
      // Faces that only touch at a point have no line between them.
      if (pathLength(path) < 0.3) return;
      // A piece across both faces' slopes on the diagonal is their crease, unless it is a short end or jog of the wall
      // (a corner placed a little off).
      const pieces = path.slice(1).map((b, n) => ({ a: path[n]!, b, len: dist(path[n]!, b) })).filter((q) => q.len >= 0.05);
      const diag = pieces.map(({ a, b, len }) => {
        const dx = (b.x - a.x) / len;
        const dy = (b.y - a.y) / len;
        return diagonal(i, dx, dy) && diagonal(j, dx, dy);
      });
      const edges: TopoLine[] = [];
      const walls: TopoLine[] = [];
      pieces.forEach(({ a, b, len }, n) => {
        if (diag[n] && (len >= prm.jogM || diag[n - 1] === true || diag[n + 1] === true)) {
          pushCrease(i, j, a, b, k);
          return;
        }
        // No wall stands along a line both roofs fall away from: where the height map falls away on both sides of a
        // level piece it is a ridge whose two sides the height map holds apart (TopologyParams.measuredRidge).
        if (prm.measuredRidge) {
          const m = peakBeside(a, b);
          if (m.both && Math.max(m.left.along, m.right.along) < prm.ridgeAlongSlope) {
            const rise = (Math.abs(planeZ(pi, b.x, b.y) - planeZ(pi, a.x, a.y)) + Math.abs(planeZ(pj, b.x, b.y) - planeZ(pj, a.x, a.y))) / 2;
            lines.push({ kind: 'ridge', a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise });
            note('crease', 'ridge', a, b, k);
            return;
          }
        }
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const [upper, lower] = planeZ(pi, mid.x, mid.y) >= planeZ(pj, mid.x, mid.y) ? [i, j] : [j, i];
        const e = faceEdge(upper, a, b, 'edge', upper === i ? 1 : -1);
        const w = faceEdge(lower, a, b, 'wall', lower === i ? 1 : -1);
        if (e !== null) edges.push(e);
        if (w !== null) walls.push(w);
      });
      const namedEdges = jogsFollow(edges, prm.jogM);
      const namedWalls = jogsFollow(walls, prm.jogM);
      lines.push(...namedEdges, ...namedWalls);
      for (const l of namedEdges) note('step-edge', l.kind, l.a, l.b, k);
      for (const l of namedWalls) note('step-wall', l.kind, l.a, l.b, k);
      return;
    }
    const a = path[0]!;
    const b = path.at(-1)!;
    if (dist(a, b) < 0.3) return;
    if (faces[i]!.fromPixels || faces[j]!.fromPixels) {
      // A face drawn from its own pixels: its corners were not where the creases put them, so the crease is the
      // boundary the two faces' pixels share, not the line between its corners.
      const pts = c.verts.map(at);
      const keep = simplifyIdx(pts, 0.25).map((q) => pts[q]!);
      if (pathLength(keep) < 0.3) return;
      for (let n = 1; n < keep.length; n++) if (dist(keep[n - 1]!, keep[n]!) >= 0.05) pushCrease(i, j, keep[n - 1]!, keep[n]!, k);
      return;
    }
    pushCrease(i, j, a, b, k);
  });
  return { faces, lines: joinCollinear(lines) };
}

/**
 * A face's edge (or a wall along it), piece by piece in order: a short piece between two longer ones of one kind on the
 * same face is a jog in that edge (a step in the eave where the wall below steps out, a notch the outline cut), and is
 * counted as that kind.
 */
export function jogsFollow(pieces: readonly TopoLine[], jogM: number): TopoLine[] {
  const plan = (l: TopoLine) => dist(l.a, l.b);
  return pieces.map((l, n) => {
    const before = pieces[n - 1];
    const after = pieces[n + 1];
    if (before === undefined || after === undefined || before.kind !== after.kind || l.kind === before.kind) return l;
    if (!(before.faces[0] === l.faces[0] && after.faces[0] === l.faces[0])) return l;
    const len = plan(l);
    return len < jogM && len < plan(before) && len < plan(after) ? { ...l, kind: before.kind } : l;
  });
}

/**
 * Pieces of one line joined: lines of the same kind along the same faces that meet end to end in a straight line (a
 * ridge a small face touches at a point, a wall's straight run) become one line, its length and rise their sums.
 */
export function joinCollinear(lines: readonly TopoLine[], maxTurnDeg = 4): TopoLine[] {
  const sinMax = Math.sin((maxTurnDeg * Math.PI) / 180);
  const out = lines.map((l) => ({ ...l, faces: [...l.faces] }));
  const alive = out.map(() => true);
  const sameFaces = (x: TopoLine, y: TopoLine) => x.faces.length === y.faces.length && x.faces.every((f) => y.faces.includes(f));
  const unit = (a: XY, b: XY): XY => {
    const d = dist(a, b);
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (let p = 0; p < out.length; p++) {
      if (!alive[p]) continue;
      for (let q = 0; q < out.length; q++) {
        if (q === p || !alive[q]) continue;
        const y = out[q]!;
        if (out[p]!.kind !== y.kind || !sameFaces(out[p]!, y)) continue;
        // x turned to end where y touches it, if it touches it at its start.
        const x0 = out[p]!;
        const x = dist(x0.b, y.a) < 1e-6 || dist(x0.b, y.b) < 1e-6 ? x0 : { ...x0, a: x0.b, b: x0.a };
        // y turned to run on from x's end, if it touches it at all.
        const [ya, yb] = dist(y.a, x.b) < 1e-6 ? [y.a, y.b] : dist(y.b, x.b) < 1e-6 ? [y.b, y.a] : [null, null];
        if (ya === null || yb === null) continue;
        const u = unit(x.a, x.b);
        const v = unit(ya, yb);
        if (u.x * v.x + u.y * v.y <= 0 || Math.abs(u.x * v.y - u.y * v.x) > sinMax) continue;
        out[p] = { ...x, b: yb, lengthM: x.lengthM + y.lengthM, riseM: x.riseM + y.riseM };
        alive[q] = false;
        changed = true;
      }
    }
  }
  return out.filter((_, k) => alive[k]);
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
