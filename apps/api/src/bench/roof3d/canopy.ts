import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import type { RoofLayers } from '../../providers/solar-layers.ts';
import { convexHull, rasterize } from './geometry.ts';

/*
 * How much tree canopy a house has over and beside its roof, measured on Google's own layers (the aerial photo and
 * the height map) and Google's roof mask, so it never changes when the reconstruction does. The benchmark's cohort
 * tags are made from it once (frozen in manifest.json).
 *
 * A pixel is TREE-LIKE when it is green in the photo (green at least as high as red and blue, and 2G - R - B >= 20, the
 * test the estimator uses for vegetation) AND rough in the height map (the second difference |4z - the four
 * neighbours| >= 0.12 m: a roof plane is smooth, a crown is not; a green roof is smooth). Foliage is a texture, not a
 * solid: only a few percent of a crown's pixels pass both tests. So a pixel is CROWN when at least CROWN_DENSITY of the
 * pixels within CROWN_RADIUS_M of it (a 1.5 m window) are tree-like. That also drops the odd noisy pixel, which a
 * plain closing would keep. Two numbers, both taken on Google's mask part under the house:
 *   roofShare  crown pixels inside the mask part / mask part pixels. Foliage that Google's mask took for roof, or
 *              branches over it.
 *   rimShare   mask-edge pixels with a crown pixel within RIM_M (1 m) of them, out or in / all mask-edge pixels. The
 *              part of the outline where trees reach the roof: the edge the reconstruction must find through them.
 * Why these two: the failures that started the canopy cohort are an outline pulled out or chamfered where branches
 * overhang the eaves (rim) and slivers on foliage Google's mask includes (roof). A roof entirely hidden by a crown
 * has no mask under it at all, so it shows in neither number; that case is reported separately by the estimator
 * ('roof-hidden') and is why the cohort also counts houses by their EagleView/Google ratio, not here.
 */

export const GREEN_MIN_EXCESS = 20;
export const ROUGH_M = 0.12;
/** A crown pixel has at least this share of tree-like pixels within CROWN_RADIUS_M of it. */
export const CROWN_DENSITY = 0.1;
export const CROWN_RADIUS_M = 0.7;
export const RIM_M = 1;
/** The mask part is the one under the point, or the nearest one within this many metres. */
export const NEAREST_PART_M = 12;

export type CanopyStats = { roofShare: number; rimShare: number; biteShare: number; maskPixels: number; rimPixels: number; imageryDate: string | null };

/** 1 where the photo is green, on the height map's grid (null without a photo). */
export function greenGrid(layers: RoofLayers): Uint8Array | null {
  const photo = layers.photo ?? null;
  if (photo === null) return null;
  const { width, height, pixelSizeM } = layers.raster;
  const out = new Uint8Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = layers.originX + (c + 0.5) * pixelSizeM;
      const y = layers.originY - (r + 0.5) * pixelSizeM;
      const pc = Math.floor((x - photo.originX) / photo.pixelSizeM);
      const pr = Math.floor((photo.originY - y) / photo.pixelSizeM);
      if (pc < 0 || pr < 0 || pc >= photo.width || pr >= photo.height) continue;
      const at = (pr * photo.width + pc) * 3;
      const red = photo.rgb[at]!;
      const green = photo.rgb[at + 1]!;
      const blue = photo.rgb[at + 2]!;
      if (green >= red && green >= blue && 2 * green - red - blue >= GREEN_MIN_EXCESS) out[r * width + c] = 1;
    }
  }
  return out;
}

/** Share of set pixels in the (2r+1)-wide square round each pixel, by an integral image; the window is clipped at the grid's edge. */
function density(src: Uint8Array, w: number, h: number, r: number): Float32Array {
  const sums = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      const n = sums[y1 * (w + 1) + x1]! - sums[y0 * (w + 1) + x1]! - sums[y1 * (w + 1) + x0]! + sums[y0 * (w + 1) + x0]!;
      out[y * w + x] = n / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Crown pixels on the height map's grid (see the file header). Null without a photo. */
export function crownGrid(layers: RoofLayers): Uint8Array | null {
  const green = greenGrid(layers);
  if (green === null) return null;
  const { width: w, height: h, dsm, pixelSizeM } = layers.raster;
  const rough = new Uint8Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (green[i] !== 1) continue;
      const z = dsm[i]!;
      const lap = Math.abs(4 * z - dsm[i - 1]! - dsm[i + 1]! - dsm[i - w]! - dsm[i + w]!);
      // NaN (no data) compares false: not rough.
      if (lap >= ROUGH_M) rough[i] = 1;
    }
  }
  const dens = density(rough, w, h, Math.max(1, Math.round(CROWN_RADIUS_M / pixelSizeM)));
  const crown = new Uint8Array(w * h);
  for (let i = 0; i < crown.length; i++) if (dens[i]! >= CROWN_DENSITY) crown[i] = 1;
  return crown;
}

/** The mask part under (or nearest to) the point: pixel indexes, eight-connected; empty when none is near. */
export function maskPartAt(layers: RoofLayers, point: LngLat): Int32Array {
  const zone = utmZoneOfEpsg(layers.epsg);
  const { width: w, height: h, mask, pixelSizeM: s } = layers.raster;
  if (zone === null) return new Int32Array(0);
  const u = lngLatToUtm(zone, point[0], point[1]);
  const pc = (u.easting - layers.originX) / s;
  const pr = (layers.originY - u.northing) / s;
  let seed = -1;
  const c0 = Math.min(w - 1, Math.max(0, Math.floor(pc)));
  const r0 = Math.min(h - 1, Math.max(0, Math.floor(pr)));
  if (mask[r0 * w + c0] !== 0 && pc >= 0 && pr >= 0 && pc < w && pr < h) seed = r0 * w + c0;
  else {
    let best = NEAREST_PART_M / s;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue;
      const c = i % w;
      const r = (i - c) / w;
      const d = Math.hypot(c + 0.5 - pc, r + 0.5 - pr);
      // Strictly nearer wins, scanning in index order: ties go to the first pixel, deterministically.
      if (d < best) {
        best = d;
        seed = i;
      }
    }
  }
  if (seed < 0) return new Int32Array(0);
  const seen = new Uint8Array(w * h);
  const stack = [seed];
  seen[seed] = 1;
  const out: number[] = [];
  while (stack.length > 0) {
    const i = stack.pop()!;
    out.push(i);
    const c = i % w;
    const r = (i - c) / w;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc;
        if (seen[j] === 1 || mask[j] === 0) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
  }
  out.sort((a, b) => a - b);
  return Int32Array.from(out);
}

/** The canopy numbers for the house at `point` (see the file header); null without a photo or a mask part. */
export function canopyStats(layers: RoofLayers, point: LngLat): CanopyStats | null {
  const crown = crownGrid(layers);
  if (crown === null) return null;
  const part = maskPartAt(layers, point);
  if (part.length === 0) return null;
  const { width: w, height: h, pixelSizeM: s, mask } = layers.raster;
  let inCrown = 0;
  for (const i of part) if (crown[i] === 1) inCrown++;
  const reach = Math.max(1, Math.round(RIM_M / s));
  let rim = 0;
  let rimCrown = 0;
  for (const i of part) {
    const c = i % w;
    const r = (i - c) / w;
    const edge = c === 0 || r === 0 || c === w - 1 || r === h - 1 || mask[i - 1] === 0 || mask[i + 1] === 0 || mask[i - w] === 0 || mask[i + w] === 0;
    if (!edge) continue;
    rim++;
    let hit = false;
    for (let dr = -reach; dr <= reach && !hit; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= h) continue;
      for (let dc = -reach; dc <= reach; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= w) continue;
        if (crown[rr * w + cc] === 1) {
          hit = true;
          break;
        }
      }
    }
    if (hit) rimCrown++;
  }
  // Bites: crown pixels in the part's convex hull that the mask does not hold, as a share of the hull. A crown that
  // hides roof leaves a notch in the mask, which the hull spans.
  const hull = convexHull(Array.from(part, (i): [number, number] => [(i % w) + 0.5, Math.floor(i / w) + 0.5]));
  const hullPx = rasterize(hull, w, h);
  let hullCount = 0;
  let bite = 0;
  for (let i = 0; i < hullPx.length; i++) {
    if (hullPx[i] !== 1) continue;
    hullCount++;
    if (crown[i] === 1 && mask[i] === 0) bite++;
  }
  return {
    biteShare: hullCount > 0 ? bite / hullCount : 0,
    roofShare: inCrown / part.length,
    rimShare: rim > 0 ? rimCrown / rim : 0,
    maskPixels: part.length,
    rimPixels: rim,
    imageryDate: layers.imageryDate,
  };
}
