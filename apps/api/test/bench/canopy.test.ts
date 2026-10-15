import { describe, expect, test } from 'vitest';
import type { LngLat } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { canopyStats, crownGrid, maskPartAt } from '../../src/bench/roof3d/canopy.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { rng, toLngLat } from './helpers.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { DEFAULT_THRESHOLDS, canopyClass } from '../../src/bench/roof3d/tags.ts';

const ORIGIN: LngLat = [-92.311, 34.7532];
const W = 14;
const D = 9;
const ring = [toLngLat(ORIGIN, 0, 0), toLngLat(ORIGIN, W, 0), toLngLat(ORIGIN, W, D), toLngLat(ORIGIN, 0, D)];
const point: LngLat = toLngLat(ORIGIN, W / 2, D / 2);

/** Makes the pixels within `metres` of the roof's side(s) crowns: green in the photo and rough in the heights. */
function addCrowns(layers: RoofLayers, sides: ('east' | 'west' | 'north' | 'south')[], metres = 3.5): RoofLayers {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const { width, height, pixelSizeM: s } = layers.raster;
  const dsm = Float32Array.from(layers.raster.dsm);
  const photo = layers.photo!;
  const rgb = Uint8Array.from(photo.rgb);
  const r = rng(3);
  const o = lngLatToUtm(zone, ORIGIN[0], ORIGIN[1]);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const x = layers.originX + (col + 0.5) * s - o.easting;
      const y = layers.originY - (row + 0.5) * s - o.northing;
      const near =
        (sides.includes('east') && x > W + 0.6 && x < W + metres && y > -1 && y < D + 1) ||
        (sides.includes('west') && x < -0.6 && x > -metres && y > -1 && y < D + 1) ||
        (sides.includes('north') && y > D + 0.6 && y < D + metres && x > -1 && x < W + 1) ||
        (sides.includes('south') && y < -0.6 && y > -metres && x > -1 && x < W + 1);
      if (!near) continue;
      dsm[row * width + col] = 6 + (r() - 0.5) * 2;
      rgb.set([40, 110, 45], row * width * 3 + col * 3);
    }
  }
  return { ...layers, raster: { ...layers.raster, dsm }, photo: { ...photo, rgb } };
}

/**
 * The fixture's grass runs right up to the roof, and its height map steps sharply from the eave down to the lawn: green
 * and rough along a thin line, which real photos do not show (the wall's shadow and the roof's overhang are there).
 * Repainted: 0.8 m outside the roof, the photo is dark.
 */
function withShadowedEaves(layers: RoofLayers): RoofLayers {
  const photo = layers.photo!;
  const rgb = Uint8Array.from(photo.rgb);
  const { width, height, mask } = layers.raster;
  const reach = 8;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (mask[r * width + c] !== 0) continue;
      let near = false;
      for (let dr = -reach; dr <= reach && !near; dr += 2) for (let dc = -reach; dc <= reach && !near; dc += 2) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < height && cc < width && mask[rr * width + cc] !== 0) near = true;
      }
      if (near) rgb.set([60, 58, 55], (r * width + c) * 3);
    }
  }
  return { ...layers, photo: { ...photo, rgb } };
}

describe('canopy numbers on a synthetic roof', () => {
  const bare = withShadowedEaves(hipLayers(ring, { pitchX12: 5 }));

  test('the mask part under the point is the roof', () => {
    const part = maskPartAt(bare, point);
    expect(part.length * 0.01).toBeGreaterThan(W * D * 0.95);
    expect(part.length * 0.01).toBeLessThan(W * D * 1.05);
  });

  test('a roof with grass round it has no crowns: grass is green but smooth', () => {
    const crowns = crownGrid(bare)!;
    expect(crowns.reduce((t, v) => t + v, 0)).toBe(0);
    const c = canopyStats(bare, point)!;
    expect(c.rimShare).toBe(0);
    expect(c.roofShare).toBe(0);
    expect(canopyClass(c.roofShare, c.rimShare, c.biteShare, DEFAULT_THRESHOLDS)).toBe('none');
  });

  test('a crown along one side reaches part of the edge: light', () => {
    const c = canopyStats(addCrowns(bare, ['east']), point)!;
    // The east edge (9 m) plus about a metre of the two edges it meets, of the 46 m outline.
    expect(c.rimShare).toBeGreaterThan(0.18);
    expect(c.rimShare).toBeLessThan(0.34);
    expect(canopyClass(c.roofShare, c.rimShare, c.biteShare, DEFAULT_THRESHOLDS)).toBe('light');
  });

  test('crowns on three sides reach most of the edge: heavy', () => {
    const c = canopyStats(addCrowns(bare, ['east', 'west', 'north']), point)!;
    expect(c.rimShare).toBeGreaterThan(0.6);
    expect(canopyClass(c.roofShare, c.rimShare, c.biteShare, DEFAULT_THRESHOLDS)).toBe('heavy');
  });

  test('without a photo there is nothing to say', () => {
    expect(canopyStats({ ...bare, photo: null }, point)).toBeNull();
  });

  test('the answer does not depend on anything but the layers and the point', () => {
    const withCrowns = addCrowns(bare, ['east']);
    expect(canopyStats(withCrowns, point)).toEqual(canopyStats(withCrowns, point));
  });
});
