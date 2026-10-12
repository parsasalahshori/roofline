import { tokens } from '@roofline/ui';
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

/** The documented minimum hail size of each level, in inches, level 1 first. */
export const HAIL_LEVEL_SIZES_IN: readonly [number, number, number, number, number] = [0.75, 1, 1.5, 2, 2.75];

/** Puts a storm-layer answer on the `storm-swath` and `storm-spots` sources. No-ops when a source is missing. */
export function applyStormData(map: MapLibreMap, data: StormLayerResponse | undefined): void {
  if (data === undefined) return;
  map.getSource<GeoJSONSource>(SOURCE.stormSwath)?.setData(data.swaths);
  map.getSource<GeoJSONSource>(SOURCE.stormSpots)?.setData(data.spots);
}

const STORM_LAYERS = [LAYER.stormSwathFill, LAYER.stormSwathOutline, LAYER.stormSpots] as const;

/** Shows or hides the swath fill, swath outline and spots layers (layout `visibility`). No-ops for a layer that is missing. */
export function setStormVisible(map: MapLibreMap, visible: boolean): void {
  for (const id of STORM_LAYERS) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  }
}
