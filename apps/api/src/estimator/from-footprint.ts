import { footprintById, footprintsNear, type LngLat, propertyOnFootprint, type TenantContext, withTenant } from '@roofline/db';
import { footprintTilesNear, metresToBuilding, outlineFromSolar, type Ring } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError } from '../errors.ts';
import { GeocoderUnavailableError } from '../providers/geocoder.ts';
import { ensureFootprintTiles } from './footprint-tiles.ts';
import { measureProperty, saveHome } from './measure.ts';
import { solarAt } from './solar.ts';

/*
 * The map's "Estimate this roof": the building under a click, and an estimate started from it. Building outlines
 * are the global footprint table the measurement code uses: a click in an area whose outlines are not loaded yet
 * loads them first (or waits for the load). Where Microsoft has no outline, Google Solar's roof under the click is
 * the building. No address lookup happens until an estimate is started; then it is one single-point reverse lookup.
 */

export const NO_BUILDING = 'no_building';
const NO_ADDRESS_MESSAGE = 'We could not find an address for this building.';
const UNAVAILABLE_MESSAGE = "Address lookup isn't available right now.";
const PICK_AGAIN_MESSAGE = 'Please pick the building on the map again.';

/** A click this close to a building outline (but outside it) still picks it: a finger or cursor near the edge. */
const PICK_SNAP_M = 8;
/** A click this close to Google Solar's building box picks that roof (where Microsoft has no outline). */
const SOLAR_PICK_M = 2;
/** The footprint tiles a click needs: its own, and the one next door within this of the edge. */
const TILE_MARGIN_M = 100;
/** The click sent with an estimate must be on or near the building it names. */
const CLICK_MAX_M = 150;
/** Reverse lookups kept per process; a building's street address does not change. */
const ADDRESS_CACHE_SIZE = 5000;

/**
 * A building picked on the map: a Microsoft footprint (`footprintId`), or, where there is none, Google Solar's roof
 * under the click (`footprintId` null, `source` 'solar': the estimate starts from the click's point instead).
 */
export type Building = {
  footprintId: string | null;
  source: 'footprint' | 'solar';
  polygon: { type: 'Polygon'; coordinates: LngLat[][] };
  centroid: { lat: number; lng: number };
};
type Address = { street: string; city: string; state: string; zip: string };

/** The area centroid of an open ring of [lng, lat] corners (planar; buildings are small); the corner mean for a degenerate ring. */
export function ringCentroid(ring: Ring): LngLat {
  const n = ring.length;
  if (n === 0) return [0, 0];
  // Relative to the first corner: raw degrees are large next to a building's tiny area, and the cross products
  // would lose their precision.
  const [ox, oy] = ring[0]!;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i += 1) {
    const [px0, py0] = ring[i]!;
    const [px1, py1] = ring[(i + 1) % n]!;
    const x0 = px0 - ox;
    const y0 = py0 - oy;
    const x1 = px1 - ox;
    const y1 = py1 - oy;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-20) {
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [ox + cx / (3 * a), oy + cy / (3 * a)];
}

function metresBetween(a: LngLat, b: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function closed(ring: Ring): LngLat[] {
  const first = ring[0];
  return first === undefined ? [] : [...ring, first];
}

function buildingOf(footprintId: string | null, ring: Ring): Building {
  const [lng, lat] = ringCentroid(ring);
  return {
    footprintId,
    source: footprintId === null ? 'solar' : 'footprint',
    polygon: { type: 'Polygon', coordinates: [closed(ring)] },
    centroid: { lat, lng },
  };
}

/**
 * The building under a point: the outline containing it, else the nearest within a few metres. When there is none,
 * the area's outlines are loaded (or waited for, up to FOOTPRINT_WAIT_MS) and it looks again; still none, Google
 * Solar's roof under the click (its outline made from Solar's roof planes). Null when no source has a roof there.
 */
export async function buildingAt(deps: AppDeps, ctx: TenantContext, point: LngLat): Promise<Building | null> {
  const near = () => withTenant(deps.pools, ctx, (tx) => footprintsNear(tx, point, PICK_SNAP_M));
  let hit = (await near())[0];
  if (hit === undefined) {
    const tiles = footprintTilesNear(point[0], point[1], TILE_MARGIN_M);
    if ((await ensureFootprintTiles(deps, tiles, { waitMs: deps.config.FOOTPRINT_WAIT_MS })) === 'ready') hit = (await near())[0];
  }
  if (hit !== undefined) return buildingOf(hit.id, hit.ring);
  const solar = await solarAt(deps, point);
  const building = solar?.building ?? null;
  if (building === null || metresToBuilding(building, point) > SOLAR_PICK_M) return null;
  const ring = outlineFromSolar(building);
  return ring === null ? null : buildingOf(null, ring);
}

/** Street addresses of footprints, by footprint id: one reverse lookup per building per process. Bounded, oldest out first. */
export class FootprintAddressCache {
  private readonly entries = new Map<string, Address | null>();
  constructor(private readonly max = ADDRESS_CACHE_SIZE) {}
  has(id: string): boolean {
    return this.entries.has(id);
  }
  get(id: string): Address | null | undefined {
    return this.entries.get(id);
  }
  set(id: string, value: Address | null): void {
    this.entries.delete(id);
    this.entries.set(id, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * The building's street address: from the cache (by footprint id, or by the point to about a metre), else one
 * single-point reverse lookup (cached, a "no address" answer too). Real in the demo when a Geocodio key is set.
 */
async function addressOf(deps: AppDeps, cache: FootprintAddressCache, key: string, at: LngLat): Promise<Address | null> {
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: Address | null;
  try {
    found = await deps.geocoder.reverse({ lat: at[1], lng: at[0] });
  } catch (err) {
    if (err instanceof GeocoderUnavailableError) throw new AppError(503, UNAVAILABLE_MESSAGE);
    throw err;
  }
  cache.set(key, found);
  return found;
}

/**
 * Starts an estimate for the building the user picked on the map. The company's home already on that building is
 * used as is (no lookup); otherwise its address comes from one reverse lookup (cached per building) and is saved
 * like a typed address (an existing home with that street and ZIP is reused). The measurement then has the picked
 * building as its selected structure. 404 `no_building` for an unknown footprint.
 */
export async function estimateFromFootprint(
  deps: AppDeps,
  ctx: TenantContext,
  cache: FootprintAddressCache,
  i: { footprintId: string; click: LngLat },
): Promise<{ measurementId: string }> {
  const footprint = await withTenant(deps.pools, ctx, (tx) => footprintById(tx, i.footprintId));
  if (footprint === null) throw new AppError(404, NO_BUILDING);
  const point = ringCentroid(footprint.ring);
  if (metresBetween(point, i.click) > CLICK_MAX_M) throw new AppError(400, PICK_AGAIN_MESSAGE, 'footprintId');

  let property = await withTenant(deps.pools, ctx, (tx) => propertyOnFootprint(tx, ctx, footprint.id));
  if (property === null) {
    const address = await addressOf(deps, cache, footprint.id, point);
    if (address === null) throw new AppError(404, NO_ADDRESS_MESSAGE);
    property = await saveHome(deps, ctx, address, point, null, deps.clock.now());
  }
  const view = await measureProperty(deps, ctx, { propertyId: property.id, footprint: { ...footprint, point } });
  return { measurementId: view.id };
}

/**
 * Starts an estimate for a roof picked on the map where no footprint is known (Google Solar's roof, or any spot):
 * the point's address comes from one reverse lookup (cached per point) and is saved like a typed address (an existing
 * home with that street and ZIP is reused); the roof is then measured at the clicked point the way Measure does it
 * (outlines loaded if need be, Google Solar's outline where Microsoft has none, draw mode only when neither has it).
 */
export async function estimateFromPoint(
  deps: AppDeps,
  ctx: TenantContext,
  cache: FootprintAddressCache,
  i: { click: LngLat },
): Promise<{ measurementId: string }> {
  const key = `point:${i.click[0].toFixed(5)},${i.click[1].toFixed(5)}`;
  const address = await addressOf(deps, cache, key, i.click);
  if (address === null) throw new AppError(404, NO_ADDRESS_MESSAGE);
  const property = await saveHome(deps, ctx, address, i.click, null, deps.clock.now());
  const view = await measureProperty(deps, ctx, { propertyId: property.id, at: i.click });
  return { measurementId: view.id };
}
