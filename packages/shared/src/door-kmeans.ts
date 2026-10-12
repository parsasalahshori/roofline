// S1 door-knock routes: pickDoors and seeded, balanced k-means (Task 5, package kmeans).
import type { Door } from './door-types.ts';
import { MAX_DOORS_PER_PLAN } from './door-types.ts';

const METRES_PER_DEGREE_LAT = 110540;
const METRES_PER_DEGREE_LNG = 111320;
const MAX_LLOYD_ITERATIONS = 25;

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Largest hail first, then key ascending. Returns a new array; the input is not mutated. */
export function pickDoors(all: Door[], max: number = MAX_DOORS_PER_PLAN): Door[] {
  if (!(max > 0)) return [];
  const sorted = all.slice().sort((a, b) => {
    if (a.hailIn !== b.hailIn) return b.hailIn - a.hailIn;
    return compareKeys(a.key, b.key);
  });
  return sorted.slice(0, Math.floor(max));
}

type Point = { x: number; y: number };

/** FNV-1a over UTF-16 code units, giving a deterministic uint32 for a seed string. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function project(doors: Door[]): Point[] {
  let latSum = 0;
  for (const d of doors) latSum += d.lat;
  const refLatRad = ((latSum / doors.length) * Math.PI) / 180;
  const cosRef = Math.cos(refLatRad);
  return doors.map((d) => ({
    x: d.lng * cosRef * METRES_PER_DEGREE_LNG,
    y: d.lat * METRES_PER_DEGREE_LAT,
  }));
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** k-means++ seeding: first centre from the rng, the rest weighted by squared distance. */
function seedCentres(pts: Point[], k: number, rng: () => number): Point[] {
  const n = pts.length;
  const chosen = new Array<boolean>(n).fill(false);
  const centres: Point[] = [];
  const first = Math.min(n - 1, Math.floor(rng() * n));
  chosen[first] = true;
  centres.push(pts[first]!);
  const nearest = new Float64Array(n);
  for (let i = 0; i < n; i++) nearest[i] = dist2(pts[i]!, pts[first]!);

  while (centres.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) if (!chosen[i]) total += nearest[i]!;
    let pick = -1;
    if (total > 0) {
      const target = rng() * total;
      let acc = 0;
      for (let i = 0; i < n; i++) {
        if (chosen[i]) continue;
        acc += nearest[i]!;
        pick = i;
        if (acc > target) break;
      }
    } else {
      // All remaining points coincide with a centre: take the first unchosen point in key order.
      pick = chosen.indexOf(false);
    }
    chosen[pick] = true;
    centres.push(pts[pick]!);
    for (let i = 0; i < n; i++) {
      const d = dist2(pts[i]!, pts[pick]!);
      if (d < nearest[i]!) nearest[i] = d;
    }
  }
  return centres;
}

/**
 * Balanced assignment: every (point, centre) pair is taken in ascending distance order and
 * accepted when the point is unassigned and the centre has room (cap = ceil(n / k)).
 * Ties break by point index then centre index. Afterwards any empty cluster takes the
 * nearest point from a cluster that has more than one door.
 */
function assignBalanced(pts: Point[], centres: Point[], cap: number): number[] {
  const n = pts.length;
  const k = centres.length;
  const pairCount = n * k;
  const pairDist = new Float64Array(pairCount);
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < k; c++) pairDist[p * k + c] = dist2(pts[p]!, centres[c]!);
  }
  const order = new Array<number>(pairCount);
  for (let i = 0; i < pairCount; i++) order[i] = i;
  order.sort((a, b) => {
    const diff = pairDist[a]! - pairDist[b]!;
    if (diff !== 0) return diff;
    return a - b;
  });

  const assign = new Array<number>(n).fill(-1);
  const load = new Array<number>(k).fill(0);
  let assigned = 0;
  for (const idx of order) {
    if (assigned === n) break;
    const p = Math.floor(idx / k);
    const c = idx - p * k;
    if (assign[p] !== -1 || load[c]! >= cap) continue;
    assign[p] = c;
    load[c]!++;
    assigned++;
  }

  // Repair: a cluster left empty takes its nearest point from a cluster with spare doors.
  for (let c = 0; c < k; c++) {
    if (load[c] !== 0) continue;
    let best = -1;
    let bestD = Infinity;
    for (let p = 0; p < n; p++) {
      if (load[assign[p]!]! <= 1) continue;
      const d = pairDist[p * k + c]!;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (best === -1) continue;
    load[assign[best]!]!--;
    assign[best] = c;
    load[c]!++;
  }
  return assign;
}

function centroids(pts: Point[], assign: number[], k: number): Point[] {
  const sx = new Float64Array(k);
  const sy = new Float64Array(k);
  const cnt = new Float64Array(k);
  for (let p = 0; p < pts.length; p++) {
    const c = assign[p]!;
    sx[c] += pts[p]!.x;
    sy[c] += pts[p]!.y;
    cnt[c] += 1;
  }
  const out: Point[] = [];
  for (let c = 0; c < k; c++) {
    out.push(cnt[c] ? { x: sx[c]! / cnt[c]!, y: sy[c]! / cnt[c]! } : { x: 0, y: 0 });
  }
  return out;
}

/**
 * Partitions doors into k balanced clusters (sizes within ceil(n / k)) with seeded k-means++
 * and at most 25 Lloyd iterations. Doors are sorted by key first, so the result does not
 * depend on input order. Deterministic for the same (doors, k, seed); no Math.random.
 */
export function clusterDoors(doors: Door[], k: number, seed: string): Door[][] {
  const n = doors.length;
  if (n === 0) return [];
  const sorted = doors.slice().sort((a, b) => compareKeys(a.key, b.key));

  if (!(k > 0)) k = 1;
  if (k >= n) return sorted.map((d) => [d]);
  k = Math.floor(k);

  const pts = project(sorted);
  const rng = mulberry32(hashSeed(seed));
  const cap = Math.ceil(n / k);

  let centres = seedCentres(pts, k, rng);
  let assign = assignBalanced(pts, centres, cap);
  for (let iter = 0; iter < MAX_LLOYD_ITERATIONS; iter++) {
    centres = centroids(pts, assign, k);
    const next = assignBalanced(pts, centres, cap);
    let same = true;
    for (let p = 0; p < n; p++) {
      if (next[p] !== assign[p]) {
        same = false;
        break;
      }
    }
    assign = next;
    if (same) break;
  }

  const clusters: Door[][] = Array.from({ length: k }, () => []);
  for (let p = 0; p < n; p++) clusters[assign[p]!]!.push(sorted[p]!);
  // Order clusters by their first key so the output shape is stable.
  return clusters
    .filter((c) => c.length > 0)
    .sort((a, b) => compareKeys(a[0]!.key, b[0]!.key));
}
