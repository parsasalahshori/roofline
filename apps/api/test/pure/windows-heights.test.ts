import { describe, expect, it } from 'vitest';
import type { LngLat } from '@roofline/shared';
import { utmToLngLat } from '@roofline/shared/roof-reconstruct';
import { eaveHeightAboveGround, mainEave, wallHeights } from '../../src/estimator/windows-heights.ts';
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

/**
 * A two-storey block (eaves 6 m) with a one-storey garage wing (eaves 3 m) on its east side, on flat ground. Hip-free
 * flat-topped boxes with a 1 m roof rise in the middle, enough to read eaves at the edges and a ridge above them.
 */
function houseWithWing(shiftM = 0): { layers: RoofLayers; ring: LngLat[] } {
  const dsm = new Float32Array(N * N);
  const mask = new Uint8Array(N * N);
  const main = { x0: 8, x1: 22, y0: 12, y1: 24, eave: 6 };
  const wing = { x0: 22, x1: 30, y0: 14, y1: 22, eave: 3 };
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const x = (c + 0.5) * S;
      const y = (r + 0.5) * S;
      let z = 100;
      for (const b of [main, wing]) {
        if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) {
          const fromEave = Math.min(x - b.x0, b.x1 - x, y - b.y0, b.y1 - y);
          z = Math.max(z, 100 + b.eave + Math.min(1.5, fromEave * 0.4));
          mask[r * N + c] = 1;
        }
      }
      dsm[r * N + c] = z;
    }
  }
  const corner = (x: number, y: number): LngLat => {
    const [lng, lat] = utmToLngLat({ zone: ZONE, south: false }, ORIGIN_X + x + shiftM, ORIGIN_Y - y);
    return [lng, lat];
  };
  // L-less outline: main block then the wing, counter-clockwise in the grid.
  const ring = [corner(8, 12), corner(22, 12), corner(22, 14), corner(30, 14), corner(30, 22), corner(22, 22), corner(22, 24), corner(8, 24)];
  return {
    layers: { raster: { width: N, height: N, pixelSizeM: S, dsm, mask }, epsg: 32600 + ZONE, originX: ORIGIN_X, originY: ORIGIN_Y, imageryQuality: 'HIGH', imageryDate: '2024-05-01' },
    ring,
  };
}

describe('wall heights wall by wall', () => {
  it('a two-storey house with a one-storey garage wing reads the main eave, not the garage’s', () => {
    const { layers: l, ring } = houseWithWing();
    const h = wallHeights(l, ring)!;
    expect(Math.abs(h.eaveM - 6)).toBeLessThan(0.4);
    // The old whole-outline reading lands on the wing's eave.
    expect(h.lowestEaveM).toBeLessThan(3.6);
    // The wing's three outer walls read about 3 m, the block's walls about 6 m.
    const wingWalls = [h.wallEavesM[3]!, h.wallEavesM[4]!];
    for (const e of wingWalls) expect(Math.abs(e - 3)).toBeLessThan(0.5);
    expect(Math.abs(h.wallEavesM[0]! - 6)).toBeLessThan(0.5);
    expect(h.ridgeM).toBeGreaterThan(h.eaveM);
    expect(eaveHeightAboveGround(l, ring)).toBe(h.eaveM);
  });

  it('a footprint drawn 1.5 m off the height map is moved onto it before reading', () => {
    const { layers: l, ring } = houseWithWing(1.5);
    const h = wallHeights(l, ring)!;
    expect(h.shiftM).toBeGreaterThan(1);
    expect(Math.abs(h.eaveM - 6)).toBeLessThan(0.4);
    expect(Math.abs(h.wallEavesM[4]! - 3)).toBeLessThan(0.5);
  });

  it('the main part is the highest level carrying enough of the walls', () => {
    // 10 m of 40 at 6 m is under MAIN_MIN_SHARE and MAIN_MIN_M: a dormer or a tree, not the main part.
    expect(mainEave([{ eaveM: 3, lengthM: 30 }, { eaveM: 6, lengthM: 10 }])).toBe(3);
    expect(mainEave([{ eaveM: 3, lengthM: 30 }, { eaveM: 6, lengthM: 20 }])).toBe(6);
    // A tree read as a wall above the ridge does not count.
    expect(mainEave([{ eaveM: 3, lengthM: 30 }, { eaveM: 9, lengthM: 20 }], 6)).toBe(3);
    expect(mainEave([{ eaveM: null, lengthM: 30 }])).toBeNull();
  });
});
