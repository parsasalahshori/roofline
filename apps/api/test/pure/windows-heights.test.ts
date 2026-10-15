import { describe, expect, it } from 'vitest';
import type { LngLat } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import { eaveHeightAboveGround } from '../../src/estimator/windows-heights.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';

/*
 * A synthetic height map: a 14 m by 10 m gable house (eaves `eave` m above the ground, ridge 2.5 m above the eaves)
 * on gently sloping ground at about 120 m above sea level, with a shrub row and a parked car next to it.
 */

const ZONE = 15;
const S = 0.25;
const N = 160; // 40 m square
const ORIGIN_X = 400_000;
const ORIGIN_Y = 4_000_040;
const HOUSE = { x0: 13, x1: 27, y0: 15, y1: 25 }; // metres in the grid

function layers(eave: number): { layers: RoofLayers; ring: LngLat[] } {
  const dsm = new Float32Array(N * N);
  const mask = new Uint8Array(N * N);
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = (c + 0.5) * S;
      const y = (r + 0.5) * S;
      const groundZ = 120 + 0.02 * x;
      let z = groundZ;
      const onHouse = x >= HOUSE.x0 && x <= HOUSE.x1 && y >= HOUSE.y0 && y <= HOUSE.y1;
      if (onHouse) {
        // Gable: rises from the long eaves (north and south) to a ridge along the middle.
        const fromEave = Math.min(y - HOUSE.y0, HOUSE.y1 - y);
        z = 120 + 0.02 * 20 + eave + (2.5 * fromEave) / 5;
        mask[r * N + c] = 1;
      } else if (y > 28 && y < 29.5) z = groundZ + 1.2; // shrubs
      else if (x > 30 && x < 34 && y > 17 && y < 19) z = groundZ + 1.5; // a car
      dsm[r * N + c] = z;
    }
  }
  const corner = (x: number, y: number): LngLat => {
    const [lng, lat] = utmToLngLat({ zone: ZONE, south: false }, ORIGIN_X + x, ORIGIN_Y - y);
    return [lng, lat];
  };
  const ring = [corner(HOUSE.x0, HOUSE.y0), corner(HOUSE.x1, HOUSE.y0), corner(HOUSE.x1, HOUSE.y1), corner(HOUSE.x0, HOUSE.y1)];
  return {
    layers: { raster: { width: N, height: N, pixelSizeM: S, dsm, mask }, epsg: 32600 + ZONE, originX: ORIGIN_X, originY: ORIGIN_Y, imageryQuality: 'HIGH', imageryDate: '2024-05-01' },
    ring,
  };
}

describe('eave height above ground', () => {
  it('finds a one-storey eave (3 m) and a two-storey one (5.9 m) within 0.4 m', () => {
    for (const eave of [3, 5.9]) {
      const { layers: l, ring } = layers(eave);
      const got = eaveHeightAboveGround(l, ring)!;
      expect(Math.abs(got - eave)).toBeLessThan(0.4);
    }
  });

  it('no data, or an outline off the grid, is null', () => {
    const { layers: l, ring } = layers(3);
    l.raster.dsm.fill(Number.NaN);
    expect(eaveHeightAboveGround(l, ring)).toBeNull();
    const far = ring.map(([lng, lat]) => [lng + 1, lat] as LngLat);
    expect(eaveHeightAboveGround(layers(3).layers, far)).toBeNull();
    expect(eaveHeightAboveGround({ ...layers(3).layers, epsg: 4326 }, ring)).toBeNull();
  });
});
