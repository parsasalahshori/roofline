import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { RoofLayers } from '../providers/solar-layers.ts';

/*
 * The walls' heights from Google's height map (Solar Data Layers' DSM, the one Measure roof reconstructs from), wall by
 * wall round the house's outline. Pure: no I/O.
 *   - Ground: the heights 2 to 8 m outside the outline, off any roof; their 25th percentile (a lower envelope: shrubs,
 *     fences and cars stand on the ground, and a sloping lot puts half the band below the other half).
 *   - Each wall's eave: the roof heights just inside that wall (0.2 to 0.8 m in, on Google's roof mask, nearest that
 *     wall); their 25th percentile. Along an eave the band is flat; along a gable end it climbs to the ridge, and the low
 *     end of it is the eave.
 *   - The main eave: the eave of the main part of the house, not the lowest one. A two-storey house with a one-storey
 *     porch, garage or wing has low walls too; the old whole-outline 10th percentile read every such house as one floor.
 *     The main part is the highest eave level (one, two or three floors) carrying at least MAIN_MIN_SHARE of the walls
 *     measured (or MAIN_MIN_M of them); its eave is their length-weighted median.
 *   - The ridge: the roof's top (98th percentile of the roof inside the outline). The main eave must sit below it.
 * The eave is about the top of the wall (an overhang hangs a little lower, a raised floor sits a little higher).
 */

const ROOF_BAND_M: [number, number] = [0.2, 0.8];
const GROUND_BAND_M: [number, number] = [2, 8];
/** Each wall's eave: this percentile of the band inside it. */
const WALL_EAVE_PERCENTILE = 0.25;
/** The whole outline's lowest eave (what the estimate used before per-wall heights): kept for comparison. */
const LOWEST_EAVE_PERCENTILE = 0.1;
const GROUND_PERCENTILE = 0.25;
const RIDGE_PERCENTILE = 0.98;
const MIN_SAMPLES = 30;
/** A wall needs this many band samples for its own eave (about 1.5 m of wall on HIGH imagery). */
const MIN_WALL_SAMPLES = 8;
/** A believable eave height above ground, metres (a one-storey eave is about 3 m; three storeys about 9). */
export const MIN_EAVE_M = 1.8;
export const MAX_EAVE_M = 15;
/** The main part: the highest eave level carrying at least this share of the measured walls, or MAIN_MIN_M of them. */
export const MAIN_MIN_SHARE = 0.3;
export const MAIN_MIN_M = 18;
/**
 * Eave levels, metres above ground: below 4.4 one floor, below 8.2 two, else three (windows-estimate floorsFromEave
 * splits the band from 4.4 to 5.2 into one and a half or two). Tuned on the floors bench
 * (docs/windows/floors-bench.md): two-storey eaves read 4.7 to 7.4 m there, three-storey ones 9 m and up.
 */
export const ONE_FLOOR_MAX_EAVE_M = 4.4;
export const TWO_FLOOR_MAX_EAVE_M = 8.2;

export function levelOf(eaveM: number): 1 | 2 | 3 {
  if (eaveM < ONE_FLOOR_MAX_EAVE_M) return 1;
  if (eaveM < TWO_FLOOR_MAX_EAVE_M) return 2;
  return 3;
}

/** What the height map says about the walls: every wall's eave, the main eave, the lowest eave and the ridge. */
export type WallHeights = {
  /** Per outline edge (edge i runs from ring[i] to ring[i + 1], the last back to ring[0]): its eave above the ground, metres; null when unread. */
  wallEavesM: (number | null)[];
  /** The main part of the house's eave above the ground, metres. */
  eaveM: number;
  /** The lowest eave round the outline (whole-outline 10th percentile), metres: a porch's or a garage's. */
  lowestEaveM: number;
  /** The roof's top above the ground, metres. */
  ridgeM: number;
  /** How far the outline was moved onto Google's roof mask to read the heights, metres (0: not moved). */
  shiftM: number;
};

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

/** The distance to the nearest edge and that edge's index (edge i: ring[i] -> ring[i + 1]). */
function nearestEdge(x: number, y: number, ring: readonly [number, number][]): { d: number; edge: number } {
  let best = Infinity;
  let edge = -1;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i]!;
    const [bx, by] = ring[(i + 1) % ring.length]!;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
    if (d < best) {
      best = d;
      edge = i;
    }
  }
  return { d: best, edge };
}

/** How far the outline may be moved onto Google's roof mask, metres, and the step of the search. */
export const ALIGN_MAX_M = 3;
const ALIGN_STEP_M = 0.25;
/** A move is kept only when it puts at least this much more of the outline on roof (share of the outline's area). */
const ALIGN_MIN_GAIN = 0.03;

/**
 * The shift (metres, grid x east and y south) that best lays the outline (grid metres) on Google's roof mask, within
 * ALIGN_MAX_M. A Microsoft footprint is traced from other imagery and often sits a metre or two off Google's height map;
 * read where it says, a wall's band falls on the ground on one side and the roof's middle on the other. Zero when no
 * move gains ALIGN_MIN_GAIN.
 */
export function maskShift(layers: RoofLayers, pts: readonly [number, number][]): [number, number] {
  const { width, height, pixelSizeM: s, mask } = layers.raster;
  const step = Math.max(s, ALIGN_STEP_M);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const nx = Math.ceil((Math.max(...xs) - x0) / step);
  const ny = Math.ceil((Math.max(...ys) - y0) / step);
  if (nx * ny > 400_000 || nx < 2 || ny < 2) return [0, 0];
  const cells: [number, number][] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * step;
      const y = y0 + (j + 0.5) * step;
      if (inside(x, y, pts)) cells.push([x, y]);
    }
  if (cells.length < 20) return [0, 0];
  const roofAt = (x: number, y: number) => {
    const c = Math.floor(x / s);
    const r = Math.floor(y / s);
    return c >= 0 && r >= 0 && c < width && r < height && mask[r * width + c] !== 0 ? 1 : 0;
  };
  const scoreOf = (dx: number, dy: number) => cells.reduce((t, [x, y]) => t + roofAt(x + dx, y + dy), 0);
  const base = scoreOf(0, 0);
  let best: [number, number] = [0, 0];
  let bestScore = base;
  const n = Math.round(ALIGN_MAX_M / step);
  for (let a = -n; a <= n; a++)
    for (let b = -n; b <= n; b++) {
      if (a === 0 && b === 0) continue;
      const dx = a * step;
      const dy = b * step;
      if (Math.hypot(dx, dy) > ALIGN_MAX_M) continue;
      const sc = scoreOf(dx, dy);
      // Ties go to the smaller move.
      if (sc > bestScore || (sc === bestScore && Math.hypot(dx, dy) < Math.hypot(best[0], best[1]))) {
        bestScore = sc;
        best = [dx, dy];
      }
    }
  return bestScore - base >= ALIGN_MIN_GAIN * cells.length ? best : [0, 0];
}

const plausible = (m: number) => m >= MIN_EAVE_M && m <= MAX_EAVE_M;
const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The main eave from the walls' eaves and lengths: the highest level with at least MAIN_MIN_SHARE of the measured
 * length (or MAIN_MIN_M), its walls' length-weighted median; capped below the ridge. Null with no wall read.
 */
export function mainEave(walls: readonly { eaveM: number | null; lengthM: number }[], ridgeM: number | null = null): number | null {
  const read = walls.filter((w): w is { eaveM: number; lengthM: number } => w.eaveM !== null && plausible(w.eaveM) && w.lengthM > 0);
  const total = read.reduce((t, w) => t + w.lengthM, 0);
  if (total <= 0) return null;
  for (const level of [3, 2, 1] as const) {
    const at = read.filter((w) => levelOf(w.eaveM) === level);
    const len = at.reduce((t, w) => t + w.lengthM, 0);
    if (len < Math.min(MAIN_MIN_M, total) && len / total < MAIN_MIN_SHARE) continue;
    const sorted = [...at].sort((a, b) => a.eaveM - b.eaveM);
    let acc = 0;
    let median = sorted[sorted.length - 1]!.eaveM;
    for (const w of sorted) {
      acc += w.lengthM;
      if (acc >= len / 2) {
        median = w.eaveM;
        break;
      }
    }
    // The eave sits below the roof's top: an "eave" at the ridge is a tree or a chimney, not a wall.
    if (ridgeM !== null && median > ridgeM - 0.3) continue;
    return median;
  }
  return null;
}

/** The walls' heights round `ring` ([lng, lat], open) on these layers; null when the height map cannot tell. */
export function wallHeights(layers: RoofLayers, ring: readonly LngLat[]): WallHeights | null {
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone === null || ring.length < 3) return null;
  const { width, height, pixelSizeM: s, dsm, mask } = layers.raster;
  // The outline in the grid's metres: x east from the left edge, y south from the top edge.
  const drawn = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(zone, lng, lat);
    return [u.easting - layers.originX, layers.originY - u.northing] as [number, number];
  });
  const [sx, sy] = maskShift(layers, drawn);
  const pts = drawn.map(([x, y]) => [x + sx, y + sy] as [number, number]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = GROUND_BAND_M[1] + s;
  const c0 = Math.max(0, Math.floor((Math.min(...xs) - pad) / s));
  const c1 = Math.min(width - 1, Math.ceil((Math.max(...xs) + pad) / s));
  const r0 = Math.max(0, Math.floor((Math.min(...ys) - pad) / s));
  const r1 = Math.min(height - 1, Math.ceil((Math.max(...ys) + pad) / s));
  if (c1 <= c0 || r1 <= r0) return null;
  const band: number[] = [];
  const perWall: number[][] = pts.map(() => []);
  const roofInside: number[] = [];
  const ground: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const i = r * width + c;
      const z = dsm[i]!;
      if (!Number.isFinite(z)) continue;
      const x = (c + 0.5) * s;
      const y = (r + 0.5) * s;
      const { d, edge } = nearestEdge(x, y, pts);
      if (inside(x, y, pts)) {
        if (mask[i] === 0) continue;
        roofInside.push(z);
        if (d >= ROOF_BAND_M[0] && d <= ROOF_BAND_M[1]) {
          band.push(z);
          perWall[edge]!.push(z);
        }
      } else if (d >= GROUND_BAND_M[0] && d <= GROUND_BAND_M[1] && mask[i] === 0) {
        ground.push(z);
      }
    }
  }
  if (band.length < MIN_SAMPLES || ground.length < MIN_SAMPLES) return null;
  const groundZ = percentile(ground, GROUND_PERCENTILE);
  const ridgeM = percentile(roofInside, RIDGE_PERCENTILE) - groundZ;
  const lowestEaveM = percentile(band, LOWEST_EAVE_PERCENTILE) - groundZ;
  const wallEavesM = perWall.map((zs) => {
    if (zs.length < MIN_WALL_SAMPLES) return null;
    const e = percentile(zs, WALL_EAVE_PERCENTILE) - groundZ;
    return plausible(e) ? r2(e) : null;
  });
  const lengths = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length]!;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const main = mainEave(
    wallEavesM.map((e, i) => ({ eaveM: e, lengthM: lengths[i]! })),
    ridgeM,
  );
  // No wall read on its own (a tiny or ragged outline): the whole band's 25th percentile, as one wall.
  const eaveM = main ?? percentile(band, WALL_EAVE_PERCENTILE) - groundZ;
  if (!plausible(eaveM)) return null;
  return {
    wallEavesM,
    eaveM: r2(eaveM),
    lowestEaveM: r2(lowestEaveM),
    ridgeM: r2(ridgeM),
    shiftM: r2(Math.hypot(sx, sy)),
  };
}

/** The main eave's height above the ground round `ring` ([lng, lat]) on these layers, metres; null when it cannot be told. */
export function eaveHeightAboveGround(layers: RoofLayers, ring: readonly LngLat[]): number | null {
  return wallHeights(layers, ring)?.eaveM ?? null;
}
