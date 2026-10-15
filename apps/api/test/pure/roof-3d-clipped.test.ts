import { describe, expect, it } from 'vitest';
import { type LngLat, type Ring, roof3dSnapshotFresh } from '@roofline/shared';
import { roof3dAt } from '../../src/estimator/roof-3d.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { buildingOf, cropLayers, NOW, pureDeps, ScriptedLayers } from './helpers.ts';

/*
 * FM05: a roof that runs off reused layers' edge came back clipped, was kept as "no roof" for 30 days, and the home was
 * measured from a footprint rectangle (205 and 310 Ridgeway Dr). Reused layers must hold the whole building with room;
 * a clipped roof buys wider layers once; an answer about one attempt is never kept.
 */

const K = (Math.PI / 180) * 6371008.8;
/** A house about 25 m (east-west) by 22 m, 4 m eaves, hip roof. */
function houseAt(lng: number, lat: number): Ring {
  const dLng = 25 / (K * Math.cos((lat * Math.PI) / 180));
  const dLat = 22 / K;
  return [
    [lng, lat],
    [lng + dLng, lat],
    [lng + dLng, lat + dLat],
    [lng, lat + dLat],
    [lng, lat],
  ];
}
const centreOf = (ring: Ring): LngLat => [(ring[0]![0] + ring[2]![0]) / 2, (ring[0]![1] + ring[2]![1]) / 2];

/** A point `m` metres west/east/south/north of `p`. */
function offset(p: LngLat, eastM: number, northM: number): LngLat {
  return [p[0] + eastM / (K * Math.cos((p[1] * Math.PI) / 180)), p[1] + northM / K];
}

/** Seeded, so every run is the same (Park-Miller). */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

describe('layers reused for another house never leave a home without its 3D roof', () => {
  it('the Ridgeway case: layers bought for a neighbour hold the point 7.5 m inside but cut the roof: fresh layers are bought, the roof is found', async () => {
    const HOUSE = houseAt(-92.3, 34.75);
    const full = hipLayers(HOUSE);
    // 12 m of margin plus 5 m of the house cut off the east: the house's centre is 7.5 m inside the edge.
    const cropped = cropLayers(full, 'east', 17);
    const layers = new ScriptedLayers((_c, _r, n) => (n === 0 ? cropped : full));
    const { deps } = pureDeps(layers);
    // A neighbour's lookup bought the cropped layers (a point in its empty west margin: no roof there).
    await roof3dAt(deps, offset(centreOf(HOUSE), -20, 0), null);
    const snap = await roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE));
    expect(snap?.none).toBeUndefined();
    expect(snap?.roof?.faces.length).toBeGreaterThanOrEqual(4);
    expect(layers.calls).toHaveLength(2);
  });

  it('property: for random roofs cut off at random sides of reused layers, never a kept "no roof", always the roof', async () => {
    const next = rng(20261014);
    for (let i = 0; i < 10; i++) {
      const HOUSE = houseAt(-92.3 + next() * 0.01, 34.75 + next() * 0.01);
      const full = hipLayers(HOUSE);
      const side = (['east', 'west', 'north', 'south'] as const)[Math.floor(next() * 4)]!;
      // Cut 1 m to (half the house - 6.5) m into the roof: the point stays at least 6 m inside, as the old reuse rule allowed.
      const halfM = side === 'east' || side === 'west' ? 12.5 : 11;
      const cutIntoRoof = 1 + next() * (halfM - 7.5);
      const cropped = cropLayers(full, side, 12 + cutIntoRoof);
      const withBuilding = next() < 0.7;
      const layers = new ScriptedLayers((_c, _r, n) => (n === 0 ? cropped : full));
      const { deps } = pureDeps(layers);
      const away = side === 'east' ? [-20, 0] : side === 'west' ? [20, 0] : side === 'north' ? [0, -18] : [0, 18];
      await roof3dAt(deps, offset(centreOf(HOUSE), away[0]!, away[1]!), null);
      const snap = await roof3dAt(deps, centreOf(HOUSE), withBuilding ? buildingOf(HOUSE) : null);
      expect(snap, `case ${i} ${side} ${cutIntoRoof.toFixed(1)} m`).not.toBeNull();
      if (snap!.roof === null) expect(roof3dSnapshotFresh(snap, centreOf(HOUSE), NOW)).toBe(false);
      expect(snap!.none, `case ${i} ${side} ${cutIntoRoof.toFixed(1)} m building=${withBuilding}`).toBeUndefined();
    }
  });

  it('a roof bigger than the layers bought for it buys wider layers once', async () => {
    const HOUSE = houseAt(-92.3, 34.75);
    const full = hipLayers(HOUSE);
    const cropped = cropLayers(full, 'north', 14);
    const layers = new ScriptedLayers((_c, _r, n) => (n === 0 ? cropped : full));
    const { deps, events } = pureDeps(layers);
    const snap = await roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE));
    expect(snap?.roof).not.toBeNull();
    expect(layers.calls).toHaveLength(2);
    expect(layers.calls[1]!.radiusM).toBeGreaterThan(layers.calls[0]!.radiusM);
    expect(events.map((e) => e.outcome)).toEqual(['clipped-retry', 'built']);
  });

  it('still clipped after the one retry: a typed "clipped" that is never kept, and the next Measure asks again', async () => {
    const HOUSE = houseAt(-92.3, 34.75);
    const cropped = cropLayers(hipLayers(HOUSE), 'north', 14);
    const layers = new ScriptedLayers(() => cropped);
    const { deps, events } = pureDeps(layers);
    const snap = await roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE));
    expect(snap).toMatchObject({ roof: null, none: 'clipped' });
    expect(roof3dSnapshotFresh(snap, centreOf(HOUSE), NOW)).toBe(false);
    expect(layers.calls).toHaveLength(2);
    expect(events.map((e) => e.outcome)).toEqual(['clipped-retry', 'clipped']);
    await roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE));
    // Asked again (not served from the in-process cache), on the layers bought, so one more retry purchase only.
    expect(events.filter((e) => e.outcome === 'clipped')).toHaveLength(2);
  });

  it('no building and no roof near the point: "no-building", kept; a building with no roof found: "no-roof", not kept', async () => {
    const HOUSE = houseAt(-92.3, 34.75);
    const full = hipLayers(HOUSE);
    const layers = new ScriptedLayers(() => full);
    const { deps } = pureDeps(layers);
    const lot = offset(centreOf(HOUSE), 0, 30);
    const empty = await roof3dAt(deps, lot, null);
    expect(empty).toMatchObject({ roof: null, none: 'no-building' });
    expect(roof3dSnapshotFresh(empty, lot, NOW)).toBe(true);
    const far = buildingOf(houseAt(-92.3, 34.75 + 30 / K));
    const missed = await roof3dAt(deps, offset(centreOf(HOUSE), 0, 31), far);
    expect(missed?.none).toBe('no-roof');
    expect(roof3dSnapshotFresh(missed, offset(centreOf(HOUSE), 0, 31), NOW)).toBe(false);
  });

  it('the roof cache is keyed by the building too: an answer without the building does not stand for one with it', async () => {
    const HOUSE = houseAt(-92.3, 34.75);
    const full = hipLayers(HOUSE);
    const layers = new ScriptedLayers(() => full);
    const { deps } = pureDeps(layers);
    const a = roof3dAt(deps, centreOf(HOUSE), null);
    const b = roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE));
    expect(a).not.toBe(b);
    expect(roof3dAt(deps, centreOf(HOUSE), buildingOf(HOUSE))).toBe(b);
    await Promise.all([a, b]);
  });
});
