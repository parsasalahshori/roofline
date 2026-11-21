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
   * slope (the direction of next to no slope is noise), where the edge is too short to measure (about 1.3 m), or where
   * the heights beside it are not a roof's (a tree's crown over the edge: they fall away from the edge, or climb along
   * it at over twice the face's slope), and only on the say of three in four of the stations along the edge.
   * Fitted on the benchmark's EagleView houses (dev): of the edge length it renames that has a clear answer there,
   * nine tenths is renamed right.
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
   * On the benchmark's EagleView houses (dev) none of the length this renames was an eave.
   */
  measuredRidge: boolean;
  fallAwaySlope: number;
  ridgeAlongSlope: number;
  /**
   * A ridge is drawn once: a line `measuredRidge` would make a ridge of, with a ridge already running alongside it
   * within this many metres over half its length, is the other side of a strip the planes cut off along that ridge: no
   * edge at all (a pitch break, drawn and never counted). 0: every such line is a ridge. On the benchmark's EagleView
   * houses (dev) nine in ten of these lines lie beside a ridge the reconstruction already has.
   */
  ridgeBesideM: number;
  /**
   * A valley is a trough: the roof rises away from it on both sides. A crease the planes call a valley, where the
   * height map 1 m out on the lower face's side lies `valleyDropM` or more BELOW the line, is no trough: the lower roof
   * is a step down the planes smoothed over, and the line is the upper face's edge over it (eave or rake, as on a wall;
   * the lower face is flashed). 0 is off, and OFF IS THE DEFAULT (0.3 is the studied value): on the benchmark's
   * EagleView houses (dev) none of the length this renames was a valley, but it leaves the valley total short by what
   * the reconstruction really misses (wrong valleys make up for missing ones), and on the held-out houses, where the
   * valleys are already a fifth short, the valley total's median error rose from 23 to 31 %. Turn it on once the
   * missing valleys are found (docs/roof-3d/line-kinds.md).
   */
  valleyDropM: number;
  /**
   * A hip is a crest: the roof falls away from it on both sides. A crease the planes call a hip that climbs the upper
   * face (it would be that face's rake), where the height map 1 m out on the upper face's side stands `hipStepM` or more
   * ABOVE the line, is the upper roof's rake over the lower roof (the lower face is step flashed). 0 turns it off.
   */
  hipStepM: number;
  /**
   * A boundary between two faces is typed piece by piece: a stretch at least this long (metres) along which the planes
   * are a step apart and the height map jumps is a wall (the upper face's eave or rake, the lower face's flashing),
   * the rest of the boundary a crease, with a corner where the wall ends (a dormer's cheek wall tapering into the
   * valley behind it; an upper storey's eave running on into a hip). 0: a boundary is typed once for its whole length.
   */
  stepPieceM: number;
  /**
   * A wall at the top of the upper face (the face falls away from it, and the lower face does not come down to it):
   * with the planes less than this far apart (metres) the two faces meet there, in a ridge or hip the height map
   * holds apart, and the line is named as their crease. 0: every such wall is a wall.
   */
  stepTopM: number;
  /**
   * A wall found for a stretch runs on, for at most this far (metres), to where the two planes meet when they close
   * steadily beyond its end: a cheek wall tapers to nothing, and the height map shows no jump over its last, low part.
   * The corner between the wall and the crease is then where the planes meet. 0: the wall ends where the jump does.
   */
  stepTaperM: number;
  /**
   * Beside such a stretch, on each face's own pixels, the height map lies on that face's plane within `stepSideTolM`
   * (metres), along at least `stepSideShare` of the stretch: a wall is a jump from one face's plane to the other's.
   * Where the pixel boundary has strayed from a crease (round a tree crown or a chimney, or at the roof's edge) one
   * side of it is not on its own plane. Tolerance 0: not asked.
   */
  stepSideTolM: number;
  stepSideShare: number;
  /**
   * A boundary is cut into a wall and a crease only when the part that is not wall lies along the planes' crease:
   * seven tenths of its points within this (metres) of that line.
   */
  stepCreaseOffM: number;
  /**
   * The faces are settled first, with every boundary typed once for its whole length (small and weak faces are
   * dissolved on the polygons that typing draws, as they always were), and the walls are typed piece by piece on the
   * faces that are left; that topology is kept unless it draws a face worse (from its pixels, or under the smallest
   * face size) that the first one drew well. False: piece by piece from the start.
   */
  stepPieceSettled: boolean;
};

/** The height map beside an edge climbs along it at most this many times the face's own slope where it is roof (measuredEdge). */
const MEASURED_ALONG_MAX = 2;
/**
 * The share of the stations beside a line that must agree, one by one, before the height map renames it (a tree's crown
 * over part of the line spoils the stations under it), and what a station's angle from level must be to agree that an
 * edge is a rake (past the plane rule's own 45 degrees) or an eave (under 60: at a hip's corner the stations at the end
 * of an eave look onto the next face). Set on the benchmark's EagleView houses (dev) and the synthetic roofs' crowns.
 */
const MEASURED_QUORUM = 0.75;
const QUORUM_RAKE_DEG = 45;
const QUORUM_EAVE_DEG = 60;

/** Of two faces at a line, one is the upper when its plane is at least this far above the other's at the line's middle, metres. */
const UPPER_GAP_M = 0.05;

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
  ridgeBesideM: 1.2,
  valleyDropM: 0,
  hipStepM: 0.6,
  stepPieceM: 1.25,
  stepTopM: 1.2,
  stepTaperM: 3,
  stepSideTolM: 0.2,
  stepSideShare: 0.4,
  stepCreaseOffM: 0.75,
  stepPieceSettled: true,
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
  /** The directed crack leaving each vertex but the last. */
  codes: number[];
  /** A stretch of a longer boundary found to be a wall (typed piece by piece). */
  wall?: boolean;
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
    const codes: number[] = [];
    let i = i0;
    let j = j0;
    let d = d0;
    for (let guard = 0; guard < 4 * L.crackCount; guard++) {
      const code = codeOf(i, j, d);
      codes.push(code);
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
    chains.push({ verts, left, right, start, end, loop: start === end, codes });
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
  // How far a direction (unit dx, dy) is from a face's level direction (across its slope), as |cos|: 1 level, 0 straight
  // up the slope; 1 on a dead-level face.
  const levelSlope = prm.levelX12 / 12;
  const levelCos = (f: number, dx: number, dy: number): number => {
    const pl = planes[f]!;
    const slope = Math.hypot(pl.a, pl.b);
    return slope < levelSlope ? 1 : Math.abs((dx * -pl.b + dy * pl.a) / slope);
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
  // The wall test at a boundary's point v: across the boundary (square to the chord from point `from` to point `to`),
  // the most the height map climbs over a short window, beyond what the steeper of the two planes climbs there. Null
  // where the chord has no length.
  const wallHalf = Math.max(1, Math.round(0.5 / s));
  const wallWin = 0.3;
  const wallExcess = (pts: readonly XY[], v: number, from: number, to: number, maxSlope: number): number | null => {
    const a = pts[from]!;
    const b = pts[to]!;
    const len = dist(a, b);
    if (len < 1e-9) return null;
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const p = pts[v]!;
    const prof: number[] = [];
    for (let t = -0.6; t <= 0.6 + 1e-9; t += s) prof.push(dsmAt(p.x + t * n.x, p.y + t * n.y));
    const w = Math.max(1, Math.round(wallWin / s));
    let jump = 0;
    for (let q = 0; q + w < prof.length; q++) {
      const d = Math.abs(prof[q + w]! - prof[q]!);
      if (Number.isFinite(d)) jump = Math.max(jump, d);
    }
    return jump - wallWin * maxSlope;
  };
  // Whether the height map lies on each face's own plane beside the boundary at point v (the left face on the left of
  // the chord from point `from` to point `to`): on each side, three of the pixels 0.2 to 1.2 m out are that face's and
  // within `tol` of its plane.
  const sidesOnPlanes = (pts: readonly XY[], v: number, from: number, to: number, left: number, right: number, tol: number): boolean => {
    const a = pts[from]!;
    const b = pts[to]!;
    const len = dist(a, b);
    if (len < 1e-9) return false;
    const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const p = pts[v]!;
    for (const [sign, f] of [[1, left], [-1, right]] as const) {
      const pl = planes[f]!;
      let on = 0;
      for (let t = 0.2; t <= 1.2 + 1e-9 && on < 3; t += s) {
        const col = Math.floor((p.x + sign * t * n.x) / s);
        const row = Math.floor(-(p.y + sign * t * n.y) / s);
        if (col < 0 || row < 0 || col >= g.w || row >= g.h || labels[row * g.w + col] !== f) continue;
        if (Math.abs(dsm[row * g.w + col]! - planeZ(pl, (col + 0.5) * s, -(row + 0.5) * s)) <= tol) on++;
      }
      if (on < 3) return false;
    }
    return true;
  };
  // A low quantile, not the median: a tree or a chimney on part of the boundary does not make it a wall.
  const lowQuantile = (xs: number[]) => xs.sort((x, y) => x - y)[Math.floor(xs.length * 0.3)] ?? 0;
  // A whole boundary's measures: how far apart the two planes are in height along it, and the wall test.
  type Measure = { pts: XY[]; gap: number; wall: number };
  const measured = new Map<Chain, Measure>();
  const measure = (c: Chain): Measure => {
    const known = measured.get(c);
    if (known !== undefined) return known;
    const pi = planes[c.left]!;
    const pj = planes[c.right]!;
    const pts = c.verts.map(at);
    const gap = lowQuantile(pts.map((p) => Math.abs(planeZ(pi, p.x, p.y) - planeZ(pj, p.x, p.y))));
    const every = Math.max(1, Math.round(0.3 / s));
    const maxSlope = Math.max(Math.hypot(pi.a, pi.b), Math.hypot(pj.a, pj.b));
    const excess: number[] = [];
    for (let v = wallHalf; v + wallHalf < pts.length; v += every) {
      const e = wallExcess(pts, v, v - wallHalf, v + wallHalf, maxSlope);
      if (e !== null) excess.push(e);
    }
    const out = { pts, gap, wall: excess.length > 0 ? lowQuantile(excess) : 0 };
    measured.set(c, out);
    return out;
  };
  const isWall = (gap: number, wall: number): boolean => gap > prm.stepM && wall > prm.stepM * 0.75;

  // Piece by piece (stepPieceM): a boundary that is not a wall for its whole length may still run along one for a
  // stretch (a dormer's cheek wall, tall at the front and tapering to nothing at the valley behind; an upper storey's
  // eave over a porch roof running on into a hip). Each stretch where the planes are a step apart and the height map
  // jumps becomes a boundary of its own, a wall, with a corner at each end of it.
  if (prm.stepPieceM > 0) {
    const minRun = Math.max(2, Math.round(prm.stepPieceM / s));
    const closeRun = Math.max(1, Math.round(0.5 / s));
    const count = chains.length;
    for (let k = 0; k < count; k++) {
      const c = chains[k]!;
      if (c.left < 0 || c.right < 0) continue;
      const m = c.verts.length - 1;
      if (m < minRun) continue;
      const whole = measure(c);
      if (isWall(whole.gap, whole.wall)) continue;
      const pi = planes[c.left]!;
      const pj = planes[c.right]!;
      const maxSlope = Math.max(Math.hypot(pi.a, pi.b), Math.hypot(pj.a, pj.b));
      // A ring with no corner on it is walked round and round; one that starts and ends at a real corner is not.
      const cyclic = c.loop && boundaryDirs(L, Math.floor(c.start / vw), c.start % vw).length < 3;
      const n = cyclic ? m : m + 1;
      const pts = whole.pts;
      let flag: boolean[] = [];
      const onPlanes: boolean[] = [];
      for (let v = 0; v < n; v++) {
        const p = pts[v]!;
        const gap = Math.abs(planeZ(pi, p.x, p.y) - planeZ(pj, p.x, p.y));
        const from = cyclic ? (v - wallHalf + 2 * m) % m : Math.max(0, v - wallHalf);
        const to = cyclic ? (v + wallHalf) % m : Math.min(m, v + wallHalf);
        const e = gap > prm.stepM ? wallExcess(pts, v, from, to, maxSlope) : null;
        const jump = e !== null && e > prm.stepM * 0.75;
        flag.push(jump);
        onPlanes.push(jump && prm.stepSideTolM > 0 && sidesOnPlanes(pts, v, from, to, c.left, c.right, prm.stepSideTolM));
      }
      const jumps = [...flag];
      flag = flipShortRuns(flag, false, closeRun, cyclic, true);
      flag = flipShortRuns(flag, true, minRun, cyclic, false);
      if (flag.includes(true)) {
        // Each stretch: both faces on their own planes beside enough of it, or not a wall.
        const start = cyclic ? Math.max(0, flag.findIndex((f, v) => f !== flag[(v + n - 1) % n])) : 0;
        for (let k0 = 0; k0 < n; ) {
          let len = 1;
          while (k0 + len < n && flag[(start + k0 + len) % n] === flag[(start + k0) % n]) len++;
          if (flag[(start + k0) % n]) {
            let all = 0;
            let on = 0;
            for (let q = 0; q < len; q++) {
              const v = (start + k0 + q) % n;
              if (jumps[v]) all++;
              if (onPlanes[v]) on++;
            }
            // And along the house's walls: a stretch mostly on the diagonal across both faces is their hip or valley.
            const run: XY[] = [];
            for (let q = 0; q < len; q++) run.push(pts[(start + k0 + q) % n]!);
            const corners = simplifyIdx(run, 0.25).map((q) => run[q]!);
            let along = 0;
            let across = 0;
            for (let q = 1; q < corners.length; q++) {
              const d = dist(corners[q - 1]!, corners[q]!);
              if (d < 1e-9) continue;
              const dx = (corners[q]!.x - corners[q - 1]!.x) / d;
              const dy = (corners[q]!.y - corners[q - 1]!.y) / d;
              along += d;
              if (diagonal(c.left, dx, dy) && diagonal(c.right, dx, dy)) across += d;
            }
            if ((prm.stepSideTolM > 0 && on < prm.stepSideShare * all) || across > 0.5 * along) for (let q = 0; q < len; q++) flag[(start + k0 + q) % n] = false;
          }
          k0 += len;
        }
      }
      if (prm.stepTaperM > 0 && flag.includes(true)) {
        const gapAt = (v: number) => Math.abs(planeZ(pi, pts[v]!.x, pts[v]!.y) - planeZ(pj, pts[v]!.x, pts[v]!.y));
        const reach = Math.round(prm.stepTaperM / s);
        const was = [...flag];
        for (let v = 0; v < n; v++) {
          if (!was[v]) continue;
          for (const dir of [1, -1]) {
            const next = (q: number) => (cyclic ? (v + dir * q + n * (reach + 1)) % n : v + dir * q);
            const first = next(1);
            if (first < 0 || first >= n || was[first]) continue;
            // From the wall's end outwards: the planes close (the pixel boundary's stair steps aside) down to nothing.
            let low = gapAt(v);
            let met = 0;
            for (let q = 1; q <= reach; q++) {
              const w = next(q);
              if (w < 0 || w >= n || was[w]) break;
              const gp = gapAt(w);
              if (gp > low + 0.25) break;
              low = Math.min(low, gp);
              if (gp < 0.12) {
                met = q;
                break;
              }
            }
            for (let q = 1; q <= met; q++) flag[next(q)] = true;
          }
        }
      }
      flag = flipShortRuns(flag, false, minRun, cyclic, false);
      if (!flag.includes(true)) continue;
      if (!flag.includes(false)) {
        c.wall = true;
        continue;
      }
      // What is left beside the wall is drawn as the planes' crease, corner to corner: it must lie along that line
      // (the valley behind a cheek wall does). A boundary that strays from its crease is left typed as a whole.
      const lb = lineBetween(pi, pj);
      if (lb === null || lb.strength < 0.05) continue;
      const off: number[] = [];
      for (let v = 0; v < n; v++) if (!flag[v]) off.push(distToLine(pts[v]!, lb.line));
      off.sort((x, y) => x - y);
      if (off[Math.floor(off.length * 0.7)]! > prm.stepCreaseOffM) continue;
      // Rotate a ring to start where a stretch starts, then cut at every change.
      let verts = c.verts;
      let codes = c.codes;
      if (cyclic) {
        let b = 0;
        for (let v = 0; v < m; v++) {
          if (flag[v] !== flag[(v + m - 1) % m]) {
            b = v;
            break;
          }
        }
        verts = [...verts.slice(b, m), ...verts.slice(0, b + 1)];
        codes = [...codes.slice(b), ...codes.slice(0, b)];
        flag = [...flag.slice(b), ...flag.slice(0, b), flag[b]!];
      }
      let from = 0;
      let first = true;
      for (let v = 1; v <= m; v++) {
        if (v < m && flag[v] === flag[v - 1]) continue;
        const piece: Chain = { verts: verts.slice(from, v + 1), codes: codes.slice(from, v), left: c.left, right: c.right, start: verts[from]!, end: verts[v]!, loop: false, wall: flag[from]! };
        if (first) chains[k] = piece;
        else {
          for (const code of piece.codes) {
            chainOfCode[code] = chains.length;
            chainOfCode[code ^ 1] = chains.length;
          }
          chains.push(piece);
        }
        first = false;
        from = v;
      }
      debug?.(`chain ${k} faces ${c.left}/${c.right} len ${(m * s).toFixed(1)} typed piece by piece`);
    }
  }

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
  const chainStats: Record<string, number>[] = chains.map(() => ({}));
  const kinds: Kind[] = chains.map((c, k) => {
    if (c.left < 0 || c.right < 0) return { type: 'outline' };
    if (contracted[k]) return { type: 'seam' };
    if (c.wall === true) return { type: 'step' };
    const pi = planes[c.left]!;
    const pj = planes[c.right]!;
    const { pts, gap, wall } = measure(c);
    const lb = lineBetween(pi, pj);
    const off = lb === null ? Infinity : lowQuantile(pts.map((p) => distToLine(p, lb.line)));
    debug?.(`chain ${k} faces ${c.left}/${c.right} len ${(c.verts.length * s).toFixed(1)} gap ${gap.toFixed(2)} off ${off.toFixed(2)} wall ${wall.toFixed(2)} strength ${lb?.strength.toFixed(2)}`);
    if (collect !== undefined) chainStats[k] = { chainGap: gap, chainOff: Number.isFinite(off) ? off : 99, chainWall: wall, chainStrength: lb?.strength ?? 0 };
    // A stretch left between walls is not a wall (c.wall false).
    if (c.wall === undefined && isWall(gap, wall)) return { type: 'step' };
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
  // Lines the height map made ridges of (TopologyParams.measuredRidge), and their development notes: a ridge is drawn
  // once, so each is checked at the end for a ridge already running alongside it.
  const peaks = new Set<TopoLine>();
  const peakNotes = new Map<TopoLine, LineFeatures>();
  const levelTan = Math.tan((prm.levelDeg * Math.PI) / 180);
  const eaveCos = Math.cos((prm.eaveDeg * Math.PI) / 180);
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
  // every 0.4 m or so along the line (clear of its ends). At each station:
  // - its rise: how the roof climbs away from the line between 0.6 and 1.5 m out (rise over run; negative: it falls
  //   away). Clear of the first half metre, where the height map rounds a roof's edge off.
  // - its climb along the line 1 m out, whichever way (the |slope| to the station about 1.2 m on): a gable's edge
  //   climbs to the peak and falls again, an eave does neither.
  // - its angle: between the two, the line's angle from level on the roof that is there (0 an eave's, 90 a rake's).
  // Returned as medians (`rise`, `along`) and, sorted, every station's rise and angle (`rises`, `angles`) for a quorum:
  // a tree's crown over part of an edge spoils the stations under it, and a name is changed only on the say of most of
  // them. NaN and empty where it cannot be read: the line too short (under about 1.3 m) or the roof beside it too narrow.
  type Beside = { rise: number; along: number; rises: number[]; angles: number[] };
  const beside = (a: XY, b: XY, side: 1 | -1): Beside => {
    const len = dist(a, b);
    if (len < 1e-6) return { rise: Number.NaN, along: Number.NaN, rises: [], angles: [] };
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
    const rise = ts.map((t) => (labelAt(a.x + ux * t + nx * 1.5, a.y + uy * t + ny * 1.5) >= 0 ? (dsmAt(a.x + ux * t + nx * 1.5, a.y + uy * t + ny * 1.5) - dsmAt(a.x + ux * t + nx * 0.6, a.y + uy * t + ny * 0.6)) / 0.9 : Number.NaN));
    const zs = ts.map((t) => zAt(t, 1));
    const lag = Math.min(3, count - 1);
    const slopes: number[] = [];
    if (lag >= 1) for (let q = 0; q + lag < count; q++) if (ts[q + lag]! - ts[q]! > 0.5) slopes.push(Math.abs(zs[q + lag]! - zs[q]!) / (ts[q + lag]! - ts[q]!));
    // Each station's own climb along the line: to the station `lag` on, or (the last ones) from the station `lag` back.
    const angles: number[] = [];
    if (lag >= 1 && ts[lag]! - ts[0]! > 0.5) {
      for (let q = 0; q < count; q++) {
        const [q1, q2] = q + lag < count ? [q, q + lag] : [q - lag, q];
        const along = Math.abs(zs[q2]! - zs[q1]!) / (ts[q2]! - ts[q1]!);
        if (Number.isFinite(along) && Number.isFinite(rise[q]!)) angles.push((Math.atan2(along, Math.abs(rise[q]!)) * 180) / Math.PI);
      }
    }
    return { rise: medianOf(rise), along: medianOf(slopes), rises: rise.filter((x) => Number.isFinite(x)).sort((x, y) => x - y), angles: angles.sort((x, y) => x - y) };
  };
  /** The value a `share` of the way up a sorted list (0 its least, 1 its greatest); NaN of none. */
  const quantile = (sorted: readonly number[], share: number): number => (sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!);
  // How far the height map 1 m out from a -> b on one side stands above (positive) or lies below the line itself, the
  // line's height being the mean of the two faces' planes there: at every station, sorted (empty off the grid).
  const standBeside = (i: number, j: number, a: XY, b: XY, side: 1 | -1): number[] => {
    const len = dist(a, b);
    if (len < 1e-6) return [];
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
    return hs.filter((h) => Number.isFinite(h)).sort((x, y) => x - y);
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
      // The height map on this side, against the line's own height (the planes' there), at five distances out.
      for (const off of [0.3, 0.6, 1, 1.5, 2.5]) {
        v[`h${tag}${off * 10}`] = medianOf(stations.map(({ p }) => dsmAt(p.x + sgn * off * nx, p.y + sgn * off * ny) - zRef(p)));
      }
      v[`roof${tag}`] = stations.filter(({ p }) => labelAt(p.x + sgn * nx, p.y + sgn * ny) >= 0).length / stations.length;
      // What the naming rules read there (`beside`, `standBeside`).
      const m = beside(a, b, sgn);
      v[`mRise${tag}`] = m.rise;
      v[`mAlong${tag}`] = m.along;
      for (const share of [0.25, 0.75]) {
        v[`mAngle${share * 100}${tag}`] = quantile(m.angles, share);
        v[`mRise${share * 100}${tag}`] = quantile(m.rises, share);
      }
      if (both) {
        const st = standBeside(left, right, a, b, sgn);
        for (const share of [0.25, 0.5, 0.75]) v[`stand${share * 100}${tag}`] = quantile(st, share);
      }
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
  const note = (src: LineFeatures['src'], kind: LineFeatures['kind'], a: XY, b: XY, k: number, left = chains[k]!.left, right = chains[k]!.right): LineFeatures | null => {
    if (collect === undefined || dist(a, b) < 0.05) return null;
    const row: LineFeatures = { src, kind, a, b, left, right, chain: k, v: featuresOf(a, b, left, right, k) };
    collect.push(row);
    return row;
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
        // A rake climbs no steeper than a roof does: heights climbing along the edge at over twice the face's own
        // slope are a tree's crown over the edge. An eave's roof climbs away from it: heights FALLING away from the
        // edge are a crown too (or the high edge of a roof, which the plane names).
        // And most of the stations must say so, one by one (a crown over part of the edge, a neighbouring face at a
        // corner): three in four past 45 degrees for a rake; three in four under 60 and climbing away for an eave.
        const toRake = deg >= prm.measuredRakeDeg && m.along <= MEASURED_ALONG_MAX * Math.hypot(pl.a, pl.b) && quantile(m.angles, 1 - MEASURED_QUORUM) >= QUORUM_RAKE_DEG;
        const toEave = deg < prm.measuredEaveDeg && m.rise > 0 && quantile(m.angles, MEASURED_QUORUM) < QUORUM_EAVE_DEG && quantile(m.rises, 1 - MEASURED_QUORUM) > 0;
        if (level && toRake) level = false;
        else if (!level && toEave) level = true;
      }
    }
    const kind: RoofLineKind3d = role === 'wall' ? (level ? 'flashing' : 'step-flashing') : level ? 'eave' : 'rake';
    return { kind, a, b, faces: [f], lengthM: Math.hypot(len, rise), riseM: rise };
  };
  // Whether the height map falls away from a -> b on both sides (TopologyParams.measuredRidge).
  const peakBeside = (a: XY, b: XY): { left: Beside; right: Beside; both: boolean } => {
    const left = beside(a, b, 1);
    const right = beside(a, b, -1);
    return { left, right, both: left.rise < -prm.fallAwaySlope && right.rise < -prm.fallAwaySlope };
  };
  // How far the height map 0.6 m out on the left of a -> b stands above (or below) the height map 0.6 m out on its
  // right: the median over the line's stations (NaN where neither side is roof). A ridge's two sides are level with
  // each other there; across a wall one stands the wall's height above the other.
  const jumpAcross = (a: XY, b: XY): number => {
    const len = dist(a, b);
    if (len < 1e-6) return Number.NaN;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const inset = Math.min(0.4, len / 4);
    const count = Math.max(1, Math.floor((len - 2 * inset) / 0.4) + 1);
    const ds: number[] = [];
    for (let q = 0; q < count; q++) {
      const t = count === 1 ? len / 2 : inset + ((len - 2 * inset) * q) / (count - 1);
      const x = a.x + ux * t;
      const y = a.y + uy * t;
      ds.push(dsmAt(x - uy * 0.6, y + ux * 0.6) - dsmAt(x + uy * 0.6, y - ux * 0.6));
    }
    return medianOf(ds);
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
    let byHeights = false;
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
        const up = prm.measuredRidge ? beside(a, b, upper === i ? 1 : -1) : null;
        if (up !== null && up.rise < -prm.fallAwaySlope && quantile(up.rises, MEASURED_QUORUM) < 0) {
          lk = 'ridge';
          byHeights = true;
        }
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
    const line: TopoLine = { kind: lk, a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise };
    if (byHeights) peaks.add(line);
    return line;
  };
  const pushCrease = (i: number, j: number, a: XY, b: XY, k: number): void => {
    const l = creaseLine(i, j, a, b);
    if (l === null) return;
    // A valley with a step down beside it, or a hip with a step up, is the upper face's edge over the lower roof
    // (TopologyParams.valleyDropM, hipStepM): named as along a wall.
    if ((l.kind === 'valley' && prm.valleyDropM > 0) || (l.kind === 'hip' && prm.hipStepM > 0)) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const gap = planeZ(planes[i]!, mid.x, mid.y) - planeZ(planes[j]!, mid.x, mid.y);
      const [upper, lower] = gap >= 0 ? [i, j] : [j, i];
      const upperSide = upper === i ? 1 : -1;
      // Which face is the upper one must not be a toss-up: the planes a little apart at the line's middle (a line drawn
      // exactly where they cross has neither above the other).
      // (The upper roof must stand above a hip at most of the stations, half as far at three in four: a crown does not.)
      const stands = Math.abs(gap) >= UPPER_GAP_M ? standBeside(i, j, a, b, l.kind === 'valley' ? (upperSide === 1 ? -1 : 1) : upperSide) : [];
      const stepped = l.kind === 'valley' ? quantile(stands, 0.5) <= -prm.valleyDropM : quantile(stands, 0.5) >= prm.hipStepM && quantile(stands, 1 - MEASURED_QUORUM) >= prm.hipStepM / 2;
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
    const row = note('crease', l.kind, a, b, k);
    if (row !== null && peaks.has(l)) peakNotes.set(l, row);
  };
  chains.forEach((c, k) => {
    if (contracted[k]) return;
    const kind = kinds[k]!;
    const path = paths[k]!;
    if (kind.type === 'outline') {
      const f = c.left >= 0 ? c.left : c.right;
      // The face is on the path's left when it is the chain's left, and round a whole outline (a loop's path is the
      // outline itself, counter-clockwise, whichever way its chain was traced).
      const faceLeft = c.loop || c.left >= 0;
      const pieces: TopoLine[] = [];
      for (let n = 1; n < path.length; n++) {
        const l = faceEdge(f, path[n - 1]!, path[n]!, 'edge', faceLeft ? 1 : -1);
        if (l !== null) pieces.push(l);
      }
      const named = jogsFollow(pieces, prm.jogM);
      lines.push(...named);
      for (const l of named) note('outline', l.kind, l.a, l.b, k, faceLeft ? f : -1, faceLeft ? -1 : f);
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
          // (Not where the height map itself stands a wall's height higher on one side: a tall step is a wall, stepTopM.)
          const jump = prm.stepTopM > 0 ? Math.abs(jumpAcross(a, b)) : 0;
          if (m.both && Math.max(m.left.along, m.right.along) < prm.ridgeAlongSlope && !(jump >= prm.stepTopM)) {
            const rise = (Math.abs(planeZ(pi, b.x, b.y) - planeZ(pi, a.x, a.y)) + Math.abs(planeZ(pj, b.x, b.y) - planeZ(pj, a.x, a.y))) / 2;
            const line: TopoLine = { kind: 'ridge', a, b, faces: [i, j], lengthM: Math.hypot(len, rise), riseM: rise };
            lines.push(line);
            peaks.add(line);
            const row = note('crease', 'ridge', a, b, k);
            if (row !== null) peakNotes.set(line, row);
            return;
          }
        }
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const [upper, lower] = planeZ(pi, mid.x, mid.y) >= planeZ(pj, mid.x, mid.y) ? [i, j] : [j, i];
        if (prm.stepTopM > 0 && !flat[upper] && Math.abs(planeZ(pi, mid.x, mid.y) - planeZ(pj, mid.x, mid.y)) < prm.stepTopM) {
          // Uphill into each face from the line (the left face is on (-dy, dx) from the path's direction).
          const dx = (b.x - a.x) / len;
          const dy = (b.y - a.y) / len;
          const into = (f: number) => (planes[f]!.a * -dy + planes[f]!.b * dx) * (f === i ? 1 : -1);
          const least = (f: number) => Math.max(prm.drainMinSlope, prm.drainShare * Math.hypot(planes[f]!.a, planes[f]!.b));
          if (into(upper) < -least(upper) && !(!flat[lower] && into(lower) > least(lower))) {
            pushCrease(i, j, a, b, k);
            return;
          }
        }
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
  // A ridge is drawn once. A line the height map made a ridge of, with a ridge already running alongside it (within
  // `ridgeBesideM` over half its length: the planes cut a strip of roof along the ridge off as a face of its own, and
  // this is the strip's other side), is no edge at all: a pitch break, drawn and never counted.
  if (peaks.size > 0 && prm.ridgeBesideM > 0) {
    const cosMax = Math.cos((25 * Math.PI) / 180);
    const settled = lines.filter((l) => l.kind === 'ridge' && !peaks.has(l));
    for (const l of lines) {
      if (!peaks.has(l)) continue;
      const len = dist(l.a, l.b);
      const ux = (l.b.x - l.a.x) / len;
      const uy = (l.b.y - l.a.y) / len;
      const n = Math.max(2, Math.round(len / 0.2));
      let covered = 0;
      for (let q = 0; q < n; q++) {
        const p = { x: l.a.x + (ux * len * (q + 0.5)) / n, y: l.a.y + (uy * len * (q + 0.5)) / n };
        const beside = settled.some((o) => {
          const ol = dist(o.a, o.b);
          if (ol < 1e-6) return false;
          const ox = (o.b.x - o.a.x) / ol;
          const oy = (o.b.y - o.a.y) / ol;
          if (Math.abs(ux * ox + uy * oy) < cosMax) return false;
          const along = (p.x - o.a.x) * ox + (p.y - o.a.y) * oy;
          return along >= -0.2 && along <= ol + 0.2 && Math.abs((p.x - o.a.x) * oy - (p.y - o.a.y) * ox) <= prm.ridgeBesideM;
        });
        if (beside) covered++;
      }
      if (covered >= n / 2) {
        l.kind = 'pitch-break';
        const row = peakNotes.get(l);
        if (row !== undefined) row.kind = 'pitch-break';
      } else settled.push(l);
    }
  }
  return { faces, lines: joinCollinear(lines) };
}

/**
 * Runs of `value` shorter than `minLen` flipped to the other value. On a ring (`cyclic`) a run may wrap round the end;
 * `insideOnly` leaves a run at either end of an open sequence alone.
 */
export function flipShortRuns(flags: readonly boolean[], value: boolean, minLen: number, cyclic: boolean, insideOnly: boolean): boolean[] {
  const n = flags.length;
  const out = [...flags];
  if (n === 0 || !flags.includes(!value)) return out;
  // Start at a change (a ring), or at 0.
  let s0 = 0;
  if (cyclic) {
    for (let v = 0; v < n; v++) {
      if (flags[v] !== flags[(v + n - 1) % n]) {
        s0 = v;
        break;
      }
    }
  }
  for (let k = 0; k < n; ) {
    let len = 1;
    while (k + len < n && flags[(s0 + k + len) % n] === flags[(s0 + k) % n]) len++;
    const atEnd = !cyclic && (k === 0 || k + len === n);
    if (flags[(s0 + k) % n] === value && len < minLen && !(insideOnly && atEnd)) for (let q = 0; q < len; q++) out[(s0 + k + q) % n] = !value;
    k += len;
  }
  return out;
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
