import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

/** The source and layer of the ring around the picked pin. Added on demand, after the app's other layers. */
export const SELECTED = { source: 'selected-pin', ring: 'selected-pin-ring' } as const;

function collection(lngLat: [number, number] | null): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: lngLat === null ? [] : [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lngLat } }],
  };
}

/**
 * Rings the picked pin in `color` (2px, around the 14px pin), or clears the ring with null. Adds the source and layer
 * the first time, and again after a style swap removed them. The ring is the company's colour, so the caller reads it
 * from the page (a map paint cannot read a CSS variable).
 */
export function setSelectedPin(map: MapLibreMap, lngLat: [number, number] | null, color: string): void {
  const data = collection(lngLat);
  const source = map.getSource<GeoJSONSource>(SELECTED.source);
  if (source) {
    source.setData(data);
    if (lngLat !== null && map.getLayer(SELECTED.ring)) map.setPaintProperty(SELECTED.ring, 'circle-stroke-color', color);
    return;
  }
  if (lngLat === null) return;
  map.addSource(SELECTED.source, { type: 'geojson', data });
  map.addLayer({
    id: SELECTED.ring,
    type: 'circle',
    source: SELECTED.source,
    paint: { 'circle-radius': 12.5, 'circle-opacity': 0, 'circle-stroke-width': 2, 'circle-stroke-color': color },
  });
}
