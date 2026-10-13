import { tokens } from '@roofline/ui';
import type { FeatureCollection, Geometry } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

/** The source and layers of the picked roof's outline. Added on demand, after the app's other layers. */
export const ROOF = {
  source: 'roof-highlight',
  fill: 'roof-highlight-fill',
  line: 'roof-highlight-line',
} as const;

function collection(geometry: Geometry | null): FeatureCollection {
  return geometry ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry }] } : { type: 'FeatureCollection', features: [] };
}

/**
 * Shows `geometry` (a roof outline) as a filled, outlined highlight, or clears it with null. Adds the source and
 * its two layers the first time, and again after a style swap removed them.
 */
export function setRoofHighlight(map: MapLibreMap, geometry: Geometry | null): void {
  const data = collection(geometry);
  const source = map.getSource<GeoJSONSource>(ROOF.source);
  if (source) {
    source.setData(data);
    return;
  }
  if (geometry === null) return;
  map.addSource(ROOF.source, { type: 'geojson', data });
  map.addLayer({ id: ROOF.fill, type: 'fill', source: ROOF.source, paint: { 'fill-color': tokens.accent, 'fill-opacity': 0.35 } });
  map.addLayer({ id: ROOF.line, type: 'line', source: ROOF.source, paint: { 'line-color': tokens.accent, 'line-width': 3 } });
}
