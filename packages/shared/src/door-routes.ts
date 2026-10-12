// S1 door-knock routes (Task 5). Public surface; splitIntoRoutes is built by package split.
import type { Door, PlannedRoute } from './door-types.ts';
import { clusterDoors } from './door-kmeans.ts';
import { orderRoute } from './door-tour.ts';
import { MAX_DOORS_PER_ROUTE } from './door-types.ts';

export * from './door-types.ts';
export { pickDoors, clusterDoors } from './door-kmeans.ts';
export { orderRoute } from './door-tour.ts';

type RouteShape = { doors: Door[]; walkMeters: number };

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Orders a cluster with orderRoute. A result over MAX_DOORS_PER_ROUTE is cut into consecutive
 * halves (at ceil(len / 2)); each half is ordered again and split further if still too long.
 */
function toRoutes(cluster: Door[]): RouteShape[] {
  const ordered = orderRoute(cluster);
  if (ordered.doors.length <= MAX_DOORS_PER_ROUTE) return [ordered];
  const half = Math.ceil(ordered.doors.length / 2);
  return [...toRoutes(ordered.doors.slice(0, half)), ...toRoutes(ordered.doors.slice(half))];
}

/**
 * Plans door-knock routes for `reps` reps. Doors are clustered into k = max(reps, ceil(n / 150))
 * seeded clusters, each ordered into a route (split if over 150 doors). Routes are then dealt
 * to reps: largest first (ties by first door key), each to the rep with the fewest doors so far
 * (ties to the lowest repIndex). Every door appears once; no route is empty or over 150 doors.
 * Deterministic for the same (doors, reps, seed); no Math.random.
 */
export function splitIntoRoutes(doors: Door[], reps: number, seed: string): PlannedRoute[] {
  const n = doors.length;
  if (n === 0) return [];
  const repCount = reps >= 1 ? Math.floor(reps) : 1;
  const k = Math.max(repCount, Math.ceil(n / MAX_DOORS_PER_ROUTE));

  const routes: RouteShape[] = [];
  for (const cluster of clusterDoors(doors, k, seed)) {
    if (cluster.length === 0) continue;
    routes.push(...toRoutes(cluster));
  }

  routes.sort((a, b) => {
    if (a.doors.length !== b.doors.length) return b.doors.length - a.doors.length;
    return compareKeys(a.doors[0]!.key, b.doors[0]!.key);
  });

  const load = new Array<number>(repCount).fill(0);
  const byRep: PlannedRoute[][] = Array.from({ length: repCount }, () => []);
  for (const route of routes) {
    let rep = 0;
    for (let r = 1; r < repCount; r++) {
      if (load[r]! < load[rep]!) rep = r;
    }
    load[rep]! += route.doors.length;
    byRep[rep]!.push({ repIndex: rep, doors: route.doors, walkMeters: route.walkMeters });
  }

  return byRep.flat();
}
