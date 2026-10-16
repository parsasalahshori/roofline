import { Map as MapLibreMap } from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { storm } from '../../copy/storm.ts';
import { HAIL_FILL_OPACITY } from '../../shell/map/layers.ts';
import { MapLegend } from '../../shell/map/MapLegend.tsx';
import { mapStyle } from '../../shell/map/mapStyle.ts';
import { hailFillExpression } from '../../shell/map/stormLayer.ts';
import { useColorScheme } from '../../shell/useColorScheme.ts';
import type { SwathCollection } from './types.ts';
import styles from './StormSwathMap.module.css';

export type StormSwathMapProps = { swath: SwathCollection };

const SOURCE = 'swath';
const LAYER = 'swath-fill';

type Box = [number, number, number, number];

/** Grows `box` to hold every [lng, lat] position found anywhere in `coordinates`. */
function extend(box: Box, coordinates: unknown): void {
  if (!Array.isArray(coordinates)) return;
  if (typeof coordinates[0] === 'number' && typeof coordinates[1] === 'number') {
    const [lng, lat] = coordinates as [number, number];
    box[0] = Math.min(box[0], lng);
    box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lng);
    box[3] = Math.max(box[3], lat);
    return;
  }
  for (const part of coordinates) extend(box, part);
}

function boundsOf(swath: SwathCollection): Box | null {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const feature of swath.features) extend(box, feature.geometry.coordinates);
  return Number.isFinite(box[0]) ? box : null;
}

function readMapEnv() {
  return { maptilerKey: import.meta.env.VITE_MAPTILER_KEY, tiles: import.meta.env.VITE_MAP_TILES };
}

/**
 * A map of where one storm's hail fell, in the page's theme, with the key floating at its bottom left like the main map's.
 * It fills the box it is put in. Without WebGL only the key shows.
 */
export function StormSwathMap({ swath }: StormSwathMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets', scheme), center: [-96, 39], zoom: 3 });
    } catch {
      return;
    }
    const bounds = boundsOf(swath);
    const install = () => {
      map.addSource(SOURCE, { type: 'geojson', data: swath as unknown as GeoJSON.FeatureCollection });
      map.addLayer({
        id: LAYER,
        type: 'fill',
        source: SOURCE,
        paint: { 'fill-color': hailFillExpression() as ExpressionSpecification, 'fill-opacity': HAIL_FILL_OPACITY },
      });
    };
    map.on('load', install);
    if (bounds) {
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 24, animate: false },
      );
    }
    return () => {
      map.remove();
    };
    // A theme switch repaints the base map: the map is made again for it
  }, [swath, scheme]);

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.map} role="region" aria-label={storm.mapLabel} />
      <MapLegend hail pins={false} />
    </div>
  );
}
