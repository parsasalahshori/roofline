import { tokens } from '@roofline/ui';
import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { StormLayerResponse } from '../../features/storm/layerTypes.ts';
import { LAYER, SOURCE } from './layers.ts';

/** The fill colour of each hail level, level 1 first. */
export const HAIL_LEVEL_COLORS: readonly [string, string, string, string, string] = [
  tokens['hail-1'],
  tokens['hail-2'],
  tokens['hail-3'],
  tokens['hail-4'],
  tokens['hail-5'],
];

/** The legend sizes in inches, level 1 first (the last one reads "or more"). */
export const HAIL_LEVEL_SIZES_IN: readonly [number, number, number, number, number] = [0.75, 1.25, 1.75, 2.5, 3];

/**
 * MapLibre fill-colour expression for a swath feature, matching `['get','thresholdIn']`:
 * 0.75 and 1 are hail-1, 1.25 and 1.5 hail-2, 1.75 and 2 hail-3, 2.5 hail-4, 3 hail-5; anything else hail-1.
 */
export function hailFillExpression(): unknown[] {
  const [c1, c2, c3, c4, c5] = HAIL_LEVEL_COLORS;
  return ['match', ['get', 'thresholdIn'], [0.75, 1], c1, [1.25, 1.5], c2, [1.75, 2], c3, [2.5], c4, [3], c5, c1];
}

function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Puts a storm-layer answer on the `storm-swath` and `storm-spots` sources. No-ops when a source is missing. */
export function applyStormData(map: MapLibreMap, data: StormLayerResponse | undefined): void {
  if (data === undefined) return;
  map.getSource<GeoJSONSource>(SOURCE.stormSwath)?.setData(data.swaths ?? emptyCollection());
  map.getSource<GeoJSONSource>(SOURCE.stormSpots)?.setData(data.spots ?? emptyCollection());
}

/** Shows or hides the swath fill, swath outline and spots layers (layout `visibility`). No-ops for a layer that is missing. */
export function setStormVisible(map: MapLibreMap, visible: boolean): void {
  // Built here, not at module level: layers.ts and this file import each other.
  for (const id of [LAYER.stormSwathFill, LAYER.stormSwathOutline, LAYER.stormSpots]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
