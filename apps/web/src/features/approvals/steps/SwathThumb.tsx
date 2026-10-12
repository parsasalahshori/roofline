import { stepAds } from '../../../copy/stepAds.ts';
import type { SwathCollection } from '../../storm/types.ts';
import styles from './SwathThumb.module.css';

/** A place on the map: longitude and latitude in degrees. */
type LngLat = { lng: number; lat: number };

const VIEW = 120;
const PAD = 8;
const METRES_PER_DEGREE = 111_320;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One GeoJSON position [lng, lat], or null when it is not two finite numbers. */
function pointOf(value: unknown): LngLat | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lng, lat] = value as unknown[];
  return isFiniteNumber(lng) && isFiniteNumber(lat) ? { lng, lat } : null;
}

/** A ring as points, or null when any position is malformed or fewer than three remain. */
function ringOf(value: unknown): LngLat[] | null {
  if (!Array.isArray(value)) return null;
  const points = value.map(pointOf);
  if (points.some((point) => point === null)) return null;
  const usable = points as LngLat[];
  return usable.length >= 3 ? usable : null;
}

/** The outer ring of each Polygon and MultiPolygon feature. Other geometry types and malformed rings are ignored. */
export function outerRingsOf(swath: SwathCollection): LngLat[][] {
  if (!Array.isArray(swath.features)) return [];
  return swath.features.flatMap((feature): LngLat[][] => {
    const geometry = feature?.geometry;
    if (geometry === null || typeof geometry !== 'object') return [];
    const coordinates = geometry.coordinates;
    if (!Array.isArray(coordinates)) return [];
    if (geometry.type === 'Polygon') {
      const ring = ringOf(coordinates[0]);
      return ring === null ? [] : [ring];
    }
    if (geometry.type === 'MultiPolygon') {
      return coordinates.flatMap((polygon: unknown): LngLat[][] => {
        if (!Array.isArray(polygon)) return [];
        const ring = ringOf(polygon[0]);
        return ring === null ? [] : [ring];
      });
    }
    return [];
  });
}

/**
 * Projects the rings into the box: metres east (x) and south (y) of the first point, equirectangular
 * (a degree of longitude is cos(lat) of a degree of latitude), then scaled to fit with padding.
 * Returns one SVG path per ring.
 */
function pathsOf(rings: LngLat[][]): string[] {
  const all = rings.flat();
  const refLat = all.reduce((sum, p) => sum + p.lat, 0) / all.length;
  const refLng = all[0]!.lng;
  const kx = METRES_PER_DEGREE * Math.cos((refLat * Math.PI) / 180);
  const raw = rings.map((ring) => ring.map((p) => ({ x: (p.lng - refLng) * kx, y: (refLat - p.lat) * METRES_PER_DEGREE })));
  const xs = raw.flat().map((p) => p.x);
  const ys = raw.flat().map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (VIEW - 2 * PAD) / span;
  const offX = (VIEW - (maxX - minX) * scale) / 2;
  const offY = (VIEW - (maxY - minY) * scale) / 2;
  return raw.map(
    (ring) =>
      `M${ring
        .map((p) => `${(offX + (p.x - minX) * scale).toFixed(2)} ${(offY + (p.y - minY) * scale).toFixed(2)}`)
        .join(' L')} Z`,
  );
}

/** A static map of the hail area: the outer edge of each swath polygon, drawn as inline SVG. Renders nothing when no ring has three points. */
export function SwathThumb({ swath }: { swath: SwathCollection }) {
  const rings = outerRingsOf(swath);
  if (rings.length === 0) return null;
  const paths = pathsOf(rings);
  return (
    <svg className={styles.thumb} viewBox={`0 0 ${VIEW} ${VIEW}`} role="img" aria-label={stepAds.thumbLabel}>
      {paths.map((d, i) => (
        <path key={i} d={d} className={styles.area} />
      ))}
    </svg>
  );
}
