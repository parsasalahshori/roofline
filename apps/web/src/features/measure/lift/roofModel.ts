import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MeasurementView } from '../types.ts';

/*
 * The measured roof: facets, the lines between them and the totals. A local copy of the shape the measurement
 * API adds as `roof` (branch demo-roofmodel); `readRoof` is the one place that reads it off a measurement.
 */
export type RoofLineKind = 'ridge' | 'hip' | 'valley' | 'eave' | 'rake';
export interface RoofFacet {
  id: string;
  ring: [number, number][];
  planSqFt: number;
  areaSqFt: number;
  pitch: string;
  labelAt: [number, number];
}
export interface RoofLine {
  kind: RoofLineKind;
  coords: [[number, number], [number, number]];
  lengthFt: number;
}
export interface RoofModel {
  facets: RoofFacet[];
  lines: RoofLine[];
  outline: [number, number][];
  pitch: string;
  totals: {
    squares: number;
    slopedSqFt: number;
    planSqFt: number;
    facetCount: number;
    wastePct: number;
    ridgeFt: number;
    hipFt: number;
    valleyFt: number;
    eaveFt: number;
    rakeFt: number;
  };
}

/** The roof the measurement carries, or null when it has none (an older API, or a roof it could not split). */
export function readRoof(m: MeasurementView): RoofModel | null {
  const roof = (m as MeasurementView & { roof?: RoofModel | null }).roof;
  return roof !== undefined && roof !== null && Array.isArray(roof.facets) && roof.facets.length > 0 ? roof : null;
}

/** Line colours, as the reference draws them. Hip only shows when the roof has hips. */
export const LINE_COLORS: Record<RoofLineKind, string> = {
  ridge: '#ff5c50',
  hip: '#ff9a3d',
  valley: '#37d3cf',
  eave: '#b294ff',
  rake: '#62dc8a',
};
export const LINE_ORDER: readonly RoofLineKind[] = ['ridge', 'hip', 'valley', 'eave', 'rake'];
const FACET_COLOR = '#2f6fde';
const CASING_COLOR = '#151c22';

/** A, B, C… then AA, AB for a roof with more than 26 facets. */
export function facetLetter(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : letters[Math.floor(index / 26) - 1]! + letters[index % 26]!;
}

/** The kinds the roof really has lines of, in legend order. */
export function lineKinds(roof: RoofModel): RoofLineKind[] {
  return LINE_ORDER.filter((kind) => kind !== 'hip' || roof.lines.some((l) => l.kind === 'hip' && l.lengthFt > 0));
}

const closed = (ring: [number, number][]): [number, number][] =>
  ring.length > 0 && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) ? [...ring, ring[0]!] : ring;

export const ROOF_FACETS_SOURCE = 'roof-facets-src';
export const ROOF_LINES_SOURCE = 'roof-lines-src';
export const ROOF_LAYERS = ['roof-facets-fill', 'roof-facets-casing', 'roof-facets-edge', 'roof-lines-casing', 'roof-lines'] as const;

export function facetsData(roof: RoofModel | null) {
  return {
    type: 'FeatureCollection' as const,
    features: (roof?.facets ?? [])
      .filter((f) => f.ring.length >= 3)
      .map((f) => ({
        type: 'Feature' as const,
        properties: { id: f.id },
        geometry: { type: 'Polygon' as const, coordinates: [closed(f.ring)] },
      })),
  };
}

export function linesData(roof: RoofModel | null) {
  return {
    type: 'FeatureCollection' as const,
    features: (roof?.lines ?? []).map((l) => ({
      type: 'Feature' as const,
      properties: { kind: l.kind, color: LINE_COLORS[l.kind] },
      geometry: { type: 'LineString' as const, coordinates: l.coords },
    })),
  };
}

type LooseMap = {
  getSource?: (id: string) => unknown;
  getLayer?: (id: string) => unknown;
  setLayoutProperty?: (id: string, name: string, value: string) => void;
};

/** The facet fills, their edges and the coloured lines, drawn on the photo so they move with it. Hidden until shown. */
export function addRoofLayers(instance: MapLibreMap, roof: RoofModel | null): void {
  try {
    instance.addSource(ROOF_FACETS_SOURCE, { type: 'geojson', data: facetsData(roof) });
    instance.addSource(ROOF_LINES_SOURCE, { type: 'geojson', data: linesData(roof) });
    const hidden = { visibility: 'none' as const };
    instance.addLayer({ id: 'roof-facets-fill', type: 'fill', source: ROOF_FACETS_SOURCE, layout: hidden, paint: { 'fill-color': FACET_COLOR, 'fill-opacity': 0.17 } });
    instance.addLayer({
      id: 'roof-facets-casing',
      type: 'line',
      source: ROOF_FACETS_SOURCE,
      layout: { ...hidden, 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.5, 'line-width': 4.2 },
    });
    instance.addLayer({
      id: 'roof-facets-edge',
      type: 'line',
      source: ROOF_FACETS_SOURCE,
      layout: { ...hidden, 'line-join': 'round' },
      paint: { 'line-color': FACET_COLOR, 'line-opacity': 0.65, 'line-width': 2 },
    });
    instance.addLayer({
      id: 'roof-lines-casing',
      type: 'line',
      source: ROOF_LINES_SOURCE,
      layout: { ...hidden, 'line-cap': 'round' },
      paint: { 'line-color': CASING_COLOR, 'line-opacity': 0.55, 'line-width': 5.6 },
    });
    instance.addLayer({
      id: 'roof-lines',
      type: 'line',
      source: ROOF_LINES_SOURCE,
      layout: { ...hidden, 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2.6 },
    });
  } catch {
    // The map may be going away; the numbers still show without the drawing.
  }
}

/** New roof data (after an edit) and whether it shows. */
export function setRoofLayers(instance: MapLibreMap, roof: RoofModel | null, visible: boolean): void {
  const loose = instance as unknown as LooseMap;
  try {
    (loose.getSource?.(ROOF_FACETS_SOURCE) as { setData?: (d: unknown) => void } | undefined)?.setData?.(facetsData(roof));
    (loose.getSource?.(ROOF_LINES_SOURCE) as { setData?: (d: unknown) => void } | undefined)?.setData?.(linesData(roof));
    for (const id of ROOF_LAYERS) {
      if (loose.getLayer?.(id) !== undefined) loose.setLayoutProperty?.(id, 'visibility', visible && roof !== null ? 'visible' : 'none');
    }
  } catch {
    // Ignored: the map is going away.
  }
}
