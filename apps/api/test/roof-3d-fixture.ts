import type { LngLat, Ring } from '@roofline/shared';
import { lngLatToUtm, utmToLngLat, type UtmZone } from '@roofline/shared/roof-reconstruct';
import type { RoofLayers } from '../src/providers/solar-layers.ts';

/*
 * Google Solar Data Layers for tests: a height map and roof mask of a hip roof over a lng/lat rectangle, on a 0.1 m
 * UTM grid the way Google sends them, with a little noise (seeded) and rounded creases.
 */

const K = (Math.PI / 180) * 6371008.8;

function zoneOf(lng: number, lat: number): UtmZone {
  return { zone: Math.floor((lng + 180) / 6) + 1, south: lat < 0 };
}

/** A hip roof at `pitchX12` over the rectangle `ring` (its sides along the meridians and parallels), 4 m eaves. */
export function hipLayers(ring: Ring, o: { pitchX12?: number; marginM?: number; quality?: string } = {}): RoofLayers {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const lng0 = Math.min(...lngs);
  const lng1 = Math.max(...lngs);
  const lat0 = Math.min(...lats);
  const lat1 = Math.max(...lats);
  const cLng = (lng0 + lng1) / 2;
  const cLat = (lat0 + lat1) / 2;
  const cos = Math.cos((cLat * Math.PI) / 180);
  const halfX = ((lng1 - lng0) / 2) * K * cos;
  const halfY = ((lat1 - lat0) / 2) * K;
  const slope = (o.pitchX12 ?? 6) / 12;
  const zone = zoneOf(cLng, cLat);
  const s = 0.1;
  const margin = o.marginM ?? 12;
  const centre = lngLatToUtm(zone, cLng, cLat);
  const half = Math.max(halfX, halfY) + margin;
  const originX = Math.round((centre.easting - half) * 10) / 10;
  const originY = Math.round((centre.northing + half) * 10) / 10;
  const width = Math.round((2 * half) / s);
  const height = width;
  const clean = new Float32Array(width * height);
  const mask = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const [lng, lat] = utmToLngLat(zone, originX + (c + 0.5) * s, originY - (r + 0.5) * s);
      const x = (lng - cLng) * K * cos;
      const y = (lat - cLat) * K;
      const inside = Math.abs(x) <= halfX && Math.abs(y) <= halfY;
      clean[r * width + c] = inside ? 4 + slope * Math.min(halfY - Math.abs(y), halfX - Math.abs(x)) : 0;
      mask[r * width + c] = inside ? 1 : 0;
    }
  }
  // Rounded creases (3 x 3 blur) and 2 cm of noise.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const dsm = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= height || cc >= width) continue;
          sum += clean[rr * width + cc]!;
          n++;
        }
      }
      dsm[r * width + c] = sum / n + (rnd() - 0.5) * 0.04;
    }
  }
  return {
    raster: { width, height, pixelSizeM: s, dsm, mask },
    epsg: (zone.south ? 32700 : 32600) + zone.zone,
    originX,
    originY,
    imageryQuality: o.quality ?? 'HIGH',
    imageryDate: '2024-05-01',
  };
}

/** Whether the layers' grid holds a point. */
export function layersCover(layers: RoofLayers): (p: LngLat) => boolean {
  const zone = { zone: layers.epsg % 100, south: layers.epsg >= 32700 };
  return ([lng, lat]) => {
    const { easting, northing } = lngLatToUtm(zone, lng, lat);
    const x = easting - layers.originX;
    const y = layers.originY - northing;
    return x >= 0 && y >= 0 && x <= layers.raster.width * layers.raster.pixelSizeM && y <= layers.raster.height * layers.raster.pixelSizeM;
  };
}
