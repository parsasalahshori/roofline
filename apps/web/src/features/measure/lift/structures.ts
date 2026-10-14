import type { LngLat, Ring } from '@roofline/shared';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MeasurementView } from '../types.ts';

export const STRUCTURES_SOURCE = 'lift-structures-src';
export const STRUCTURE_LAYERS = ['lift-structures-fill', 'lift-structures-line'] as const;
/** The outline drawn round a building under the pointer (or its row): shown whatever else is showing. */
export const STRUCTURE_HOVER_LAYER = 'lift-structures-hover';
const INCLUDED_COLOR = '#2563eb';
const LEFT_OUT_COLOR = '#475569';
const HOVER_COLOR = '#ffc21a';

type Structure = MeasurementView['structures'][number];

/** Buildings are listed when their edge is this close to the main house's (always, when they are in the quote). */
export const BUILDING_LIST_RADIUS_M = 25;
/**
 * A building at least this share of the main house's size, and farther from the address point than the main house,
 * is probably a neighbour's house rather than a garage or shed on the same lot.
 */
export const NEIGHBOUR_SIZE_SHARE = 0.6;

export type BuildingRole = 'main' | 'detached' | 'neighbour';

/** A building near the home, as the Adjust list and the map's popover describe it. */
export type BuildingRow = {
  footprintId: string;
  ring: Ring;
  areaSqFt: number;
  included: boolean;
  role: BuildingRole;
  /** Edge to edge from the main house, metres (0 for the main house). */
  gapM: number;
  /** Whether the Adjust list shows it: near the main house, or in the quote. */
  listed: boolean;
};

const M_PER_DEG = 111_320;
type XY = { x: number; y: number };

function localFrame(origin: LngLat): (p: LngLat) => XY {
  const cos = Math.cos((origin[1] * Math.PI) / 180);
  return (p) => ({ x: (p[0] - origin[0]) * M_PER_DEG * cos, y: (p[1] - origin[1]) * M_PER_DEG });
}

/** Whether a point lies inside a ring (open or closed; ray casting, fine at a building's size). */
export function insideRing(point: LngLat, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Metres from a point to a ring's edge; 0 when the point is inside it. */
export function metresToRing(point: LngLat, ring: Ring): number {
  if (ring.length === 0) return Number.POSITIVE_INFINITY;
  if (insideRing(point, ring)) return 0;
  const at = localFrame(point);
  const pts = ring.map(at);
  const origin = { x: 0, y: 0 };
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < pts.length; i++) best = Math.min(best, segmentDistance(origin, pts[i]!, pts[(i + 1) % pts.length]!));
  return best;
}

/** Metres between two rings, edge to edge; 0 when they touch or overlap. */
export function metresBetweenRings(a: Ring, b: Ring): number {
  if (a.length === 0 || b.length === 0) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const p of a) best = Math.min(best, metresToRing(p, b));
  for (const p of b) best = Math.min(best, metresToRing(p, a));
  return best;
}

/** The main building's index: the one marked main, else the first (older measurements). -1 with none. */
export function mainIndex(structures: readonly Structure[]): number {
  if (structures.length === 0) return -1;
  const marked = structures.findIndex((s) => s.main === true);
  return marked >= 0 ? marked : 0;
}

/**
 * The buildings near the home in the order the list shows them (the main house first, then by distance from it), each
 * with its role: the main house; another house (at least NEIGHBOUR_SIZE_SHARE of the main house's size and farther
 * from the address point than it): probably a neighbour's; anything else a detached building on the lot.
 */
export function describeBuildings(structures: readonly Structure[], center: LngLat): BuildingRow[] {
  const at = mainIndex(structures);
  if (at < 0) return [];
  const main = structures[at]!;
  const mainFromPoint = metresToRing(center, main.ring);
  const rows = structures.map((s, i): BuildingRow => {
    if (i === at) return { footprintId: s.footprintId, ring: s.ring, areaSqFt: s.areaSqFt, included: s.included, role: 'main', gapM: 0, listed: true };
    const gapM = metresBetweenRings(main.ring, s.ring);
    const houseSized = s.areaSqFt >= NEIGHBOUR_SIZE_SHARE * main.areaSqFt;
    const role: BuildingRole = houseSized && metresToRing(center, s.ring) > mainFromPoint ? 'neighbour' : 'detached';
    return { footprintId: s.footprintId, ring: s.ring, areaSqFt: s.areaSqFt, included: s.included, role, gapM, listed: s.included || gapM <= BUILDING_LIST_RADIUS_M };
  });
  return [rows[at]!, ...rows.filter((_, i) => i !== at).sort((a, b) => a.gapM - b.gapM)];
}

/** The building a point falls in (the first listed one), or null. */
export function buildingAt(rows: readonly BuildingRow[], point: LngLat): BuildingRow | null {
  return rows.find((r) => r.ring.length >= 3 && insideRing(point, r.ring)) ?? null;
}

/** The only building still in the quote (the one that cannot be left out), or null when more than one is in. */
export function onlyIncluded(rows: readonly BuildingRow[]): string | null {
  const inQuote = rows.filter((r) => r.included);
  return inQuote.length === 1 ? inQuote[0]!.footprintId : null;
}

export function structuresData(structures: MeasurementView['structures'], hovered: string | null = null) {
  return {
    type: 'FeatureCollection' as const,
    features: structures
      .filter((s) => s.ring.length >= 3)
      .map((s) => ({
        type: 'Feature' as const,
        properties: { id: s.footprintId, included: s.included, hovered: s.footprintId === hovered },
        geometry: { type: 'Polygon' as const, coordinates: [[...s.ring, s.ring[0] as [number, number]]] },
      })),
  };
}

/** The tint and edge of each structure. Add these before the outline editor, so the editable outline draws on top. */
export function addStructureLayers(instance: MapLibreMap, structures: MeasurementView['structures']): void {
  try {
    instance.addSource(STRUCTURES_SOURCE, { type: 'geojson', data: structuresData(structures) });
    instance.addLayer({
      id: 'lift-structures-fill',
      type: 'fill',
      source: STRUCTURES_SOURCE,
      paint: {
        'fill-color': ['case', ['get', 'included'], INCLUDED_COLOR, LEFT_OUT_COLOR],
        'fill-opacity': ['case', ['get', 'included'], 0.28, 0.1],
      },
    });
    instance.addLayer({
      id: 'lift-structures-line',
      type: 'line',
      source: STRUCTURES_SOURCE,
      paint: {
        'line-color': ['case', ['get', 'included'], INCLUDED_COLOR, LEFT_OUT_COLOR],
        'line-width': 2,
        'line-opacity': ['case', ['get', 'included'], 1, 0.35],
      },
    });
    instance.addLayer({
      id: STRUCTURE_HOVER_LAYER,
      type: 'line',
      source: STRUCTURES_SOURCE,
      filter: ['==', ['get', 'hovered'], true],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': HOVER_COLOR, 'line-width': 3.5 },
    });
  } catch {
    // The map may be mid-teardown; the outline still works without the tint.
  }
}
