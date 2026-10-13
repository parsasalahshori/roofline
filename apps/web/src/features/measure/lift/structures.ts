import type { Map as MapLibreMap } from 'maplibre-gl';
import type { MeasurementView } from '../types.ts';

export const STRUCTURES_SOURCE = 'lift-structures-src';
const INCLUDED_COLOR = '#2563eb';
const LEFT_OUT_COLOR = '#475569';

export function structuresData(structures: MeasurementView['structures']) {
  return {
    type: 'FeatureCollection' as const,
    features: structures
      .filter((s) => s.ring.length >= 3)
      .map((s) => ({
        type: 'Feature' as const,
        properties: { included: s.included },
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
  } catch {
    // The map may be mid-teardown; the outline still works without the tint.
  }
}
