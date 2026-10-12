// S1 door-knock routes: nearest neighbour + 2-opt (Task 5, package tour).
// Pure and deterministic: no randomness, and the result does not depend on input order.
import type { Door } from './door-types.ts';

const METERS_PER_DEG_LAT = 110540;
const METERS_PER_DEG_LNG = 111320;
const MAX_TWO_OPT_PASSES = 50;
const MIN_GAIN_METERS = 1e-9;

type Dist = (a: Door, b: Door) => number;

// Equirectangular distance in metres. One meanLat is fixed for a whole call: the midpoint of the
// latitude range, which is the same for any ordering of the same set of doors.
function distanceFn(doors: Door[]): Dist {
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const d of doors) {
    if (d.lat < minLat) minLat = d.lat;
    if (d.lat > maxLat) maxLat = d.lat;
  }
  const meanLatRad = (((minLat + maxLat) / 2) * Math.PI) / 180;
  const cosLat = Math.cos(meanLatRad);
  return (a, b) => {
    const dx = (b.lng - a.lng) * cosLat * METERS_PER_DEG_LNG;
    const dy = (b.lat - a.lat) * METERS_PER_DEG_LAT;
    return Math.hypot(dx, dy);
  };
}

function byKey(a: Door, b: Door): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// Start door: nearest to the cluster's north-west corner (max lat, min lng), ties by key.
function startDoor(sorted: Door[], dist: Dist): Door {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  for (const d of sorted) {
    if (d.lat < minLat) minLat = d.lat;
    if (d.lat > maxLat) maxLat = d.lat;
    if (d.lng < minLng) minLng = d.lng;
  }
  const corner: Door = { key: '', lat: maxLat, lng: minLng, hailIn: 0 };
  let best = sorted[0]!;
  let bestDist = dist(corner, best);
  for (let i = 1; i < sorted.length; i++) {
    const candidate = sorted[i]!;
    const d = dist(corner, candidate);
    if (d < bestDist) {
      best = candidate;
      bestDist = d;
    }
  }
  return best;
}

// Open nearest-neighbour path from the start door. `remaining` is key-ascending, so a strict "<"
// comparison breaks distance ties by key ascending.
function nearestNeighbourPath(doors: Door[], dist: Dist): Door[] {
  const sorted = doors.slice().sort(byKey);
  const start = startDoor(sorted, dist);
  const remaining = sorted.filter((d) => d !== start);
  const path: Door[] = [start];
  let current = start;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDist = dist(current, remaining[0]!);
    for (let i = 1; i < remaining.length; i++) {
      const d = dist(current, remaining[i]!);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    current = remaining.splice(bestIndex, 1)[0]!;
    path.push(current);
  }
  return path;
}

function reverseSegment(path: Door[], i: number, j: number): void {
  let lo = i;
  let hi = j;
  while (lo < hi) {
    const tmp = path[lo]!;
    path[lo] = path[hi]!;
    path[hi] = tmp;
    lo++;
    hi--;
  }
}

// 2-opt on an open path. The first door stays fixed (segments start at index >= 1). Reversing a
// tail (j = last index) only changes one edge, because the path has no closing edge.
function twoOpt(path: Door[], dist: Dist): Door[] {
  const p = path.slice();
  const n = p.length;
  for (let pass = 0; pass < MAX_TWO_OPT_PASSES; pass++) {
    let improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const removed = dist(p[i - 1]!, p[i]!);
        let delta: number;
        if (j === n - 1) {
          delta = dist(p[i - 1]!, p[j]!) - removed;
        } else {
          delta =
            dist(p[i - 1]!, p[j]!) + dist(p[i]!, p[j + 1]!) - removed - dist(p[j]!, p[j + 1]!);
        }
        if (delta < -MIN_GAIN_METERS) {
          reverseSegment(p, i, j);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return p;
}

function pathLength(path: Door[], dist: Dist): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += dist(path[i - 1]!, path[i]!);
  }
  return total;
}

// Total length in metres of an open path, in the given order.
export function routeLength(doors: Door[]): number {
  if (doors.length < 2) return 0;
  return pathLength(doors, distanceFn(doors));
}

// Nearest-neighbour ordering only (no 2-opt). Used as the baseline in tests.
export function nearestNeighbourOrder(doors: Door[]): { doors: Door[]; walkMeters: number } {
  if (doors.length === 0) return { doors: [], walkMeters: 0 };
  const dist = distanceFn(doors);
  const path = nearestNeighbourPath(doors, dist);
  return { doors: path, walkMeters: pathLength(path, dist) };
}

export function orderRoute(doors: Door[]): { doors: Door[]; walkMeters: number } {
  if (doors.length === 0) return { doors: [], walkMeters: 0 };
  if (doors.length === 1) return { doors: [doors[0]!], walkMeters: 0 };
  const dist = distanceFn(doors);
  const path = twoOpt(nearestNeighbourPath(doors, dist), dist);
  return { doors: path, walkMeters: pathLength(path, dist) };
}
