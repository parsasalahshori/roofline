import { latestSolarSnapshot, type TenantContext, withTenant } from '@roofline/db';
import {
  dominantPitchX12,
  type LngLat,
  metresToBuilding,
  type PitchSource,
  planesOverRing,
  type Ring,
  roofPlanesOf,
  type RoofPlane,
  type SolarSnapshot,
  solarSnapshotFresh,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { SolarUnavailableError } from '../providers/solar.ts';

/*
 * Google Solar for the estimator: the answer for a home's point (asked once, then kept: on the measurement, and for
 * a while in this process so a prefetch and the Measure after it share one paid call), and the pitch it gives.
 */

/** Answers asked for in this process, by point (about 1 m), shared by a prefetch and the Measure after it. */
const asked = new WeakMap<AppDeps, Map<string, { at: number; value: Promise<SolarSnapshot | null> }>>();
const ASKED_TTL_MS = 30 * 60 * 1000;
const ASKED_MAX = 500;
/** A Solar building this far from the home's point is a neighbour's, not the home's. */
export const SOLAR_BUILDING_SNAP_M = 30;

function key(point: LngLat): string {
  return `${point[0].toFixed(5)},${point[1].toFixed(5)}`;
}

/**
 * Google Solar's building at a point, as a snapshot to keep. Null when Solar is not set up or did not answer (that is
 * not kept, so the next measure asks again). A lookup for the same point within ASKED_TTL_MS shares the first one.
 */
export function solarAt(deps: AppDeps, point: LngLat): Promise<SolarSnapshot | null> {
  if (!deps.solar.configured) return Promise.resolve(null);
  let map = asked.get(deps);
  if (map === undefined) {
    map = new Map();
    asked.set(deps, map);
  }
  const k = key(point);
  const hit = map.get(k);
  if (hit !== undefined && Date.now() - hit.at < ASKED_TTL_MS) return hit.value;
  const entries = map;
  const value = deps.solar.buildingInsights(point).then(
    (building): SolarSnapshot => ({ fetchedAt: deps.clock.now().toISOString(), at: [point[0], point[1]], building }),
    (err: unknown) => {
      if (!(err instanceof SolarUnavailableError)) deps.logError?.(err, 'google-solar');
      if (entries.get(k)?.value === value) entries.delete(k);
      return null;
    },
  );
  map.set(k, { at: Date.now(), value });
  while (map.size > ASKED_MAX) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  return value;
}

/** The Solar answer for a saved home: the one kept on its newest measurement when still fresh, else `solarAt`. */
export async function solarForHome(deps: AppDeps, ctx: TenantContext, propertyId: string, point: LngLat): Promise<SolarSnapshot | null> {
  if (!deps.solar.configured) return null;
  const kept = await withTenant(deps.pools, ctx, (tx) => latestSolarSnapshot(tx, ctx, propertyId));
  if (kept !== null && solarSnapshotFresh(kept, point, deps.clock.now())) return kept;
  return solarAt(deps, point);
}

/** The pitch a measurement starts with, where it came from, and the planes its facets take their own pitch from. */
export type PitchPick = { pitchX12: number; source: PitchSource; planes: RoofPlane[] | null };

/**
 * The roof's pitch from Google Solar: the area-weighted dominant pitch of the planes over the outline (`ring`; all
 * of the building's planes when there is no outline yet, if the building is at the home), with those planes for the
 * facets. `fallback` (source 'default') when Solar has nothing for this roof: no building, a neighbour's building,
 * or no usable planes.
 */
export function pitchFromSolar(snapshot: SolarSnapshot | null, ring: Ring | null, point: LngLat, fallback: number): PitchPick {
  const none: PitchPick = { pitchX12: fallback, source: 'default', planes: null };
  const building = snapshot?.building ?? null;
  if (building === null) return none;
  let planes = roofPlanesOf(building);
  if (ring !== null) planes = planesOverRing(planes, ring);
  else if (metresToBuilding(building, point) > SOLAR_BUILDING_SNAP_M) return none;
  const dominant = dominantPitchX12(planes);
  if (dominant === null) return none;
  return { pitchX12: dominant, source: 'solar', planes };
}
