import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { RoofLayers } from '../providers/solar-layers.ts';

/*
 * The walls' height from Google's height map (Solar Data Layers' DSM, the one Measure roof reconstructs from): the
 * eave's height above the ground round the house's outline. Pure: no I/O.
 *   - Eave: the roof heights just inside the outline (0.2 to 0.8 m in), on Google's roof mask; their 10th percentile,
 *     because the eaves are the lowest part of a roof and the band also crosses gables and hips that rise from them.
 *   - Ground: the heights 2 to 8 m outside the outline, off any roof; their 25th percentile (a lower envelope: shrubs,
 *     fences and cars stand on the ground, and a sloping lot puts half the band below the other half).
 * The eave is about the top of the wall (an overhang hangs a little lower, a raised floor sits a little higher).
 */

const ROOF_BAND_M: [number, number] = [0.2, 0.8];
const GROUND_BAND_M: [number, number] = [2, 8];
const EAVE_PERCENTILE = 0.1;
const GROUND_PERCENTILE = 0.25;
const MIN_SAMPLES = 30;
/** A believable eave height above ground, metres (a one-storey eave is about 3 m; three storeys about 9). */
const MIN_EAVE_M = 1.8;
const MAX_EAVE_M = 15;

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
}

function inside(x: number, y: number, ring: readonly [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function edgeDistance(x: number, y: number, ring: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]!;
    const [bx, by] = ring[i]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

/** The eave's height above the ground round `ring` ([lng, lat]) on these layers, metres; null when it cannot be told. */
export function eaveHeightAboveGround(layers: RoofLayers, ring: readonly LngLat[]): number | null {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null || ring.length < 3) return null;
  const { width, height, pixelSizeM: s, dsm, mask } = layers.raster;
  // The outline in the grid's metres: x east from the left edge, y south from the top edge.
  const pts = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(zone, lng, lat);
    return [u.easting - layers.originX, layers.originY - u.northing] as [number, number];
  });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = GROUND_BAND_M[1] + s;
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - pad) / s));
  const c1 = Math.min(width - 1, Math.ceil((Math.max(...xs) + pad) / s));
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - pad) / s));
  const r1 = Math.min(height - 1, Math.ceil((Math.max(...ys) + pad) / s));
  if (c1 <= c0 || r1 <= r0) return null;
  const roof: number[] = [];
  const ground: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * width + c;
      const z = dsm[i]!;
      if (!Number.isFinite(z)) continue;
      const x = (c + 0.5) * s;
      const y = (r + 0.5) * s;
      const d = edgeDistance(x, y, pts);
      if (inside(x, y, pts)) {
        if (d >= ROOF_BAND_M[0] && d <= ROOF_BAND_M[1] && mask[i] !== 0) roof.push(z);
      } else if (d >= GROUND_BAND_M[0] && d <= GROUND_BAND_M[1] && mask[i] === 0) {
        ground.push(z);
      }
    }
  }
  if (roof.length < MIN_SAMPLES || ground.length < MIN_SAMPLES) return null;
  const eave = percentile(roof, EAVE_PERCENTILE) - percentile(ground, GROUND_PERCENTILE);
  return eave >= MIN_EAVE_M && eave <= MAX_EAVE_M ? Math.round(eave * 100) / 100 : null;
}
