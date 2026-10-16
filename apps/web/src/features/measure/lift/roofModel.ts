import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MeasurementView } from '../types.ts';
import { lineQuoted, type LngLat, type RoofLineKind, type RoofModel } from '@roofline/shared';
import { insideRing } from './structures.ts';

/** The measured roof (facets, the lines between them, the totals) as the measurement API worked it out. */
export type { RoofFacet, RoofLine, RoofLineKind, RoofModel } from '@roofline/shared';

/** The roof the measurement carries, or null when it has none (an older API, or a roof it could not split). */
export function readRoof(m: MeasurementView): RoofModel | null {
  return usableRoof(m.roof);
}

/** A roof with facets, or null. */
export function usableRoof(roof: RoofModel | null | undefined): RoofModel | null {
  return roof !== null && roof !== undefined && Array.isArray(roof.facets) && roof.facets.length > 0 ? roof : null;
}

/**
 * Line colours, as the reference draws them. Hips, flashing and flat edges only show when the roof has them.
 * The map draws these on its canvas over aerial photos, so they are literal and the same in light and dark (the CSS stays
 * on tokens); the legend swatches in the page read them from here.
 */
export const LINE_COLORS: Record<RoofLineKind, string> = {
  ridge: '#ff5c50',
  hip: '#ff9a3d',
  valley: '#37d3cf',
  eave: '#b294ff',
  rake: '#62dc8a',
  flashing: '#f4f1e8',
  'step-flashing': '#ffd23f',
  'flat-edge': '#9aa7b4',
};
export const LINE_ORDER: readonly RoofLineKind[] = ['ridge', 'hip', 'valley', 'eave', 'rake', 'flashing', 'step-flashing', 'flat-edge'];
/** Kinds only some roofs have (a roof measured in 3D): shown only when the roof has them, like hips. */
const WHEN_PRESENT: ReadonlySet<RoofLineKind> = new Set(['hip', 'flashing', 'step-flashing', 'flat-edge']);
/**
 * Flashing runs where a higher roof's eave or rake hangs over a lower roof, so the two lines share their place: the
 * flashing is drawn after the others and thinner, a stripe down the middle of the eave or rake.
 */
const UNDER_EDGE: ReadonlySet<RoofLineKind> = new Set(['flashing', 'step-flashing']);
const FACET_COLOR = '#2f6fde';
const CASING_COLOR = '#151c22';
/** A facet left out of the quote is shaded over, and its lines that no longer count fade. */
const LEFT_OUT_FILL = '#151c22';

/** The facet's own letter (the API names them A, B… largest first), else A, B, C… by position. */
export function facetName(id: string, index: number): string {
  return /^[A-Z]{1,2}$/.test(id) ? id : facetLetter(index);
}

/** A, B, C… then AA, AB for a roof with more than 26 facets. */
export function facetLetter(index: number): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return index < 26 ? letters[index]! : letters[Math.floor(index / 26) - 1]! + letters[index % 26]!;
}

/** The kinds the roof really has lines of, in legend order (hips, flashing and flat edges only when it has them). */
export function lineKinds(roof: RoofModel): RoofLineKind[] {
  return LINE_ORDER.filter((kind) => !WHEN_PRESENT.has(kind) || roof.lines.some((l) => l.kind === kind && l.lengthFt > 0));
}

const closed = (ring: [number, number][]): [number, number][] =>
  ring.length > 0 && (ring[0]![0] !== ring.at(-1)![0] || ring[0]![1] !== ring.at(-1)![1]) ? [...ring, ring[0]!] : ring;

export const ROOF_FACETS_SOURCE = 'roof-facets-src';
export const ROOF_LINES_SOURCE = 'roof-lines-src';
export const ROOF_LAYERS = ['roof-facets-fill', 'roof-facets-casing', 'roof-facets-edge', 'roof-lines-casing', 'roof-lines'] as const;

export function facetsData(roof: RoofModel | null) {
  const out = new Set(roof?.excluded ?? []);
  return {
    type: 'FeatureCollection' as const,
    features: (roof?.facets ?? [])
      .filter((f) => f.ring.length >= 3)
      .map((f) => ({
        type: 'Feature' as const,
        properties: { id: f.id, excluded: out.has(f.id) },
        geometry: { type: 'Polygon' as const, coordinates: [closed(f.ring)] },
      })),
  };
}

export function linesData(roof: RoofModel | null) {
  const out = new Set(roof?.excluded ?? []);
  const quoted = new Set((roof?.facets ?? []).filter((f) => !out.has(f.id)).map((f) => f.id));
  return {
    type: 'FeatureCollection' as const,
    features: [...(roof?.lines ?? [])].sort((a, b) => Number(UNDER_EDGE.has(a.kind)) - Number(UNDER_EDGE.has(b.kind))).map((l) => ({
      type: 'Feature' as const,
      properties: { kind: l.kind, color: LINE_COLORS[l.kind], width: UNDER_EDGE.has(l.kind) ? 1.2 : 2.6, quoted: out.size === 0 || lineQuoted(l, quoted) },
      geometry: { type: 'LineString' as const, coordinates: l.coords },
    })),
  };
}

/** The facet a point falls in, or null. */
export function facetAt(roof: RoofModel | null, point: LngLat): string | null {
  return roof?.facets.find((f) => f.ring.length >= 3 && insideRing(point, f.ring))?.id ?? null;
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
    instance.addLayer({
      id: 'roof-facets-fill',
      type: 'fill',
      source: ROOF_FACETS_SOURCE,
      layout: hidden,
      paint: {
        'fill-color': ['case', ['get', 'excluded'], LEFT_OUT_FILL, FACET_COLOR],
        'fill-opacity': ['case', ['get', 'excluded'], 0.55, 0.17],
      },
    });
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
      paint: { 'line-color': ['case', ['get', 'excluded'], '#94a3b8', FACET_COLOR], 'line-opacity': 0.65, 'line-width': 2 },
    });
    instance.addLayer({
      id: 'roof-lines-casing',
      type: 'line',
      source: ROOF_LINES_SOURCE,
      layout: { ...hidden, 'line-cap': 'round' },
      paint: { 'line-color': CASING_COLOR, 'line-opacity': ['case', ['get', 'quoted'], 0.55, 0.2], 'line-width': 5.6 },
    });
    instance.addLayer({
      id: 'roof-lines',
      type: 'line',
      source: ROOF_LINES_SOURCE,
      layout: { ...hidden, 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-opacity': ['case', ['get', 'quoted'], 1, 0.3] },
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
