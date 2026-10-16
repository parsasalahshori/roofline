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
 * MapLibre fill-colour expression for a swath feature, stepping on `['get','thresholdIn']`: below 1.25 (0.75, 1)
 * is hail-1, 1.25 and 1.5 hail-2, 1.75 and 2 hail-3, 2.5 hail-4, 3 and above hail-5. A `step`, not a `match`:
 * MapLibre refuses a `match` with decimal labels, which left every swath undrawn.
 */
export function hailFillExpression(): unknown[] {
  const [c1, c2, c3, c4, c5] = HAIL_LEVEL_COLORS;
  return ['step', ['get', 'thresholdIn'], c1, 1.25, c2, 1.75, c3, 2.5, c4, 3, c5];
}

/**
 * The outline of a swath band: the next level's colour, one step darker than its fill (the biggest band keeps its
 * own). The design draws a 1.2px stroke in it over a 40% fill, so each band reads as a contour and not a blur.
 */
export function hailStrokeExpression(): unknown[] {
  const [, c2, c3, c4, c5] = HAIL_LEVEL_COLORS;
  return ['step', ['get', 'thresholdIn'], c2, 1.25, c3, 1.75, c4, 2.5, c5, 3, c5];
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
