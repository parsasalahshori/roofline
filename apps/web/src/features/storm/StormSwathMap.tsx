import { Map as MapLibreMap } from 'maplibre-gl';
import type { ExpressionSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';
import { storm } from '../../copy/storm.ts';
import { mapStyle } from '../../shell/map/mapStyle.ts';
import type { SwathCollection } from './types.ts';
import styles from './StormSwathMap.module.css';

export type StormSwathMapProps = { swath: SwathCollection };

const LEVELS = ['0.75', '1.25', '1.75', '2.50', '3.00'] as const;
const FALLBACKS = ['#ffe066', '#ffb347', '#ff7a45', '#f0508c', '#c026d3'] as const;
const SOURCE = 'swath';
const LAYER = 'swath-fill';

/** The five hail colours as real strings (MapLibre cannot read CSS variables). */
function hailColors(): string[] {
  const style = getComputedStyle(document.documentElement);
  return FALLBACKS.map((fallback, index) => style.getPropertyValue(`--hail-${index + 1}`).trim() || fallback);
}

/** Colours a contour by its inches: 0.75 and 1 are level 1, 1.25 and 1.5 level 2, 1.75 and 2 level 3, 2.5 level 4, 3 level 5. */
function fillColor(colors: string[]): ExpressionSpecification {
  const [c1, c2, c3, c4, c5] = colors as [string, string, string, string, string];
  return [
    'match',
    ['get', 'thresholdIn'],
    [0.75, 1],
    c1,
    [1.25, 1.5],
    c2,
    [1.75, 2],
    c3,
    [2.5],
    c4,
    [3],
    c5,
    c1,
  ];
}

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

/** A small map of where hail fell, with the legend under it. Without WebGL only the legend shows. */
export function StormSwathMap({ swath }: StormSwathMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container, style: mapStyle(readMapEnv(), 'streets'), center: [-96, 39], zoom: 3 });
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
        paint: { 'fill-color': fillColor(hailColors()), 'fill-opacity': 0.45 },
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
  }, [swath]);

  return (
    <div className={styles.root}>
      <div ref={containerRef} className={styles.map} role="img" aria-label={storm.mapLabel} />
      <h3 className={styles.legendHeading}>{storm.legendHeading}</h3>
      <ul className={styles.legend} aria-label={storm.legendHeading}>
        {LEVELS.map((level, index) => (
          <li key={level} className={styles.item}>
            <span className={styles.swatch} data-level={index + 1} aria-hidden="true" />
            {storm.legendLevel(level)}
          </li>
        ))}
      </ul>
    </div>
  );
}
