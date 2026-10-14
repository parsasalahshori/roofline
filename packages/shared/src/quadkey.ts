/*
 * Bing Maps tile quadkeys (Web Mercator). Microsoft's Global ML Building Footprints are published one
 * file (or a few) per zoom-9 quadkey, so a footprint load is one tile: about 70 km on a side in the US.
 */

/** The zoom the building footprint files are tiled at. */
export const FOOTPRINT_TILE_ZOOM = 9;

const MAX_LAT = 85.05112878;
const EARTH_RADIUS_M = 6_378_137;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The point's position in the world as fractions (0..1) from the top left (Web Mercator). */
function worldXY(lng: number, lat: number): { x: number; y: number } {
  const sin = Math.sin((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180);
  return { x: (clamp(lng, -180, 180) + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

function tileQuadkey(tx: number, ty: number, zoom: number): string {
  let key = '';
  for (let i = zoom; i > 0; i--) {
    const mask = 1 << (i - 1);
    let digit = 0;
    if ((tx & mask) !== 0) digit += 1;
    if ((ty & mask) !== 0) digit += 2;
    key += String(digit);
  }
  return key;
}

/** The quadkey of the tile at `zoom` that holds the point. */
export function quadkeyOf(lng: number, lat: number, zoom: number = FOOTPRINT_TILE_ZOOM): string {
  const n = 2 ** zoom;
  const { x, y } = worldXY(lng, lat);
  return tileQuadkey(clamp(Math.floor(x * n), 0, n - 1), clamp(Math.floor(y * n), 0, n - 1), zoom);
}

/** True for a quadkey of the footprint zoom: exactly nine digits 0-3. */
export function isFootprintQuadkey(v: string): boolean {
  return new RegExp(`^[0-3]{${FOOTPRINT_TILE_ZOOM}}$`).test(v);
}

/**
 * The footprint tiles a lookup at the point needs: its own tile first, then any neighbouring tile
 * (edge or corner) the point is within `marginM` metres of. A building near a tile edge can be
 * filed in the tile next door, so a lookup there needs both.
 */
export function footprintTilesNear(lng: number, lat: number, marginM = 100, zoom: number = FOOTPRINT_TILE_ZOOM): string[] {
  const n = 2 ** zoom;
  const { x, y } = worldXY(lng, lat);
  const tx = clamp(Math.floor(x * n), 0, n - 1);
  const ty = clamp(Math.floor(y * n), 0, n - 1);
  // Metres per tile at this latitude (Web Mercator scale: the equator length times cos(lat), over n).
  const tileM = (2 * Math.PI * EARTH_RADIUS_M * Math.cos((clamp(lat, -MAX_LAT, MAX_LAT) * Math.PI) / 180)) / n;
  const margin = marginM / tileM;
  const fx = x * n - tx;
  const fy = y * n - ty;
  const dxs = [0, ...(fx < margin ? [-1] : []), ...(fx > 1 - margin ? [1] : [])];
  const dys = [0, ...(fy < margin ? [-1] : []), ...(fy > 1 - margin ? [1] : [])];
  const out: string[] = [];
  for (const dy of dys) {
    for (const dx of dxs) {
      const nx = tx + dx;
      const ny = ty + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      out.push(tileQuadkey(nx, ny, zoom));
    }
  }
  return out;
}
