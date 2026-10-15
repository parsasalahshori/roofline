import { afterEach, describe, expect, it, vi } from 'vitest';
import { type LngLat, type Ring, roof3dSnapshotStamp, type Roof3dSnapshot } from '@roofline/shared';
import { roof3dAt, roof3dFromKept, roof3dOnBoughtLayers } from '../../src/estimator/roof-3d.ts';
import { roof3dCounts } from '../../src/estimator/roof-3d-events.ts';
import { SolarLayersUnavailableError } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { buildingOf, pureDeps, ScriptedLayers } from './helpers.ts';

/*
 * ROOF_3D_MODE (the kill switch): on measures from the 3D roof; shadow works it out and keeps it but measures the old
 * way; off buys nothing. Plus the typed timeout and the counters.
 */

const HOUSE: Ring = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];
const LAYERS = hipLayers(HOUSE);

afterEach(() => {
  vi.useRealTimers();
});

describe('ROOF_3D_MODE', () => {
  it('on: the 3D roof is measured from', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps } = pureDeps(layers, { mode: 'on' });
    const snap = await roof3dFromKept(deps, null, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(snap?.roof?.faces).toHaveLength(4);
    expect(snap?.shadowRoof).toBeUndefined();
    expect(roof3dCounts(deps).built).toBe(1);
  });

  it('shadow: the roof is worked out and kept as shadowRoof, the measurement goes the old way (roof null), and turning it on reuses it', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps, events } = pureDeps(layers, { mode: 'shadow' });
    const snap = await roof3dFromKept(deps, null, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(snap).toMatchObject({ roof: null, none: 'shadow' });
    expect(snap?.shadowRoof?.faces).toHaveLength(4);
    expect(events.map((e) => e.outcome)).toContain('shadow');
    expect(events.map((e) => e.outcome)).toContain('fallback');
    // The measurement kept the shadow snapshot; the mode is switched on: no new purchase, the roof is used.
    const { deps: onDeps } = pureDeps(layers, { mode: 'on' });
    const again = await roof3dFromKept(onDeps, snap, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(again?.roof?.faces).toHaveLength(4);
    expect(layers.calls).toHaveLength(1);
  });

  it('shadow counts a shadow-diff when the roof is more than 10% off Google\'s segments', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps } = pureDeps(layers, { mode: 'shadow' });
    const building = { ...buildingOf(HOUSE), segments: [{ pitchDeg: 26.6, azimuthDeg: 180, groundAreaM2: 20, center: INSIDE }] } as never;
    await roof3dFromKept(deps, null, INSIDE, Promise.resolve(building));
    expect(roof3dCounts(deps)['shadow-diff']).toBe(1);
  });

  it('off: nothing is read or bought, and nothing is returned', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps } = pureDeps(layers, { mode: 'off' });
    expect(await roof3dFromKept(deps, null, INSIDE, Promise.resolve(buildingOf(HOUSE)))).toBeNull();
    expect(await roof3dAt(deps, INSIDE, buildingOf(HOUSE))).toBeNull();
    expect(await roof3dOnBoughtLayers(deps, INSIDE)).toBeNull();
    expect(layers.calls).toHaveLength(0);
    expect(roof3dCounts(deps).off).toBe(2);
  });

  it('a kept snapshot from an older algorithm is not reused: the roof is worked out again (and counted)', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps } = pureDeps(layers);
    const first = await roof3dFromKept(deps, null, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    const legacy: Roof3dSnapshot = { fetchedAt: first!.fetchedAt, at: first!.at, roof: first!.roof };
    const { deps: later } = pureDeps(layers);
    const again = await roof3dFromKept(later, legacy, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(again?.algorithmVersion).toBe(roof3dSnapshotStamp(legacy).algorithmVersion);
    expect(roof3dCounts(later)['stale-snapshot']).toBe(1);
    expect(layers.calls).toHaveLength(2);
    // A current one is reused: nothing bought.
    const { deps: third } = pureDeps(layers);
    await roof3dFromKept(third, again, INSIDE, Promise.resolve(buildingOf(HOUSE)));
    expect(layers.calls).toHaveLength(2);
    expect(roof3dCounts(third).reused).toBe(1);
  });
});

describe('failures are typed, never thrown', () => {
  it('layers that never come: a typed timeout after the budget, not kept, and the Measure goes on', async () => {
    vi.useFakeTimers();
    const layers = new ScriptedLayers(() => new Promise(() => {}));
    const { deps } = pureDeps(layers);
    const pending = roof3dAt(deps, INSIDE, buildingOf(HOUSE));
    await vi.advanceTimersByTimeAsync(41_000);
    const snap = await pending;
    expect(snap).toMatchObject({ roof: null, none: 'timeout' });
    expect(roof3dCounts(deps).timeout).toBe(1);
  });

  it('Data Layers failing: null (asked again next time), counted with its reason; a building promise that rejects is no building', async () => {
    const layers = new ScriptedLayers(() => {
      throw new SolarLayersUnavailableError('down', 'http');
    });
    const { deps, events, errors } = pureDeps(layers);
    expect(await roof3dFromKept(deps, null, INSIDE, Promise.reject(new Error('solar down')))).toBeNull();
    expect(events.find((e) => e.outcome === 'unavailable')).toMatchObject({ reason: 'http' });
    expect(errors).toHaveLength(0);
  });

  it('a miss with Google\'s building unknown (its lookup failed) is no-roof, never the 30-day no-building', async () => {
    // A point on the ground about 14 m off the house's north-east corner: the reconstruction finds no roof there.
    const off: LngLat = [-95.999587, 41.250298];
    const known = pureDeps(new ScriptedLayers(() => LAYERS));
    expect(await roof3dFromKept(known.deps, null, off, Promise.resolve(null))).toMatchObject({ roof: null, none: 'no-building' });
    const failed = pureDeps(new ScriptedLayers(() => LAYERS));
    expect(await roof3dFromKept(failed.deps, null, off, Promise.reject(new Error('solar down')))).toMatchObject({ roof: null, none: 'no-roof' });
    const unknown = pureDeps(new ScriptedLayers(() => LAYERS));
    expect(await roof3dFromKept(unknown.deps, null, off, Promise.resolve(undefined))).toMatchObject({ roof: null, none: 'no-roof' });
  });

  it('a point that is not finite: null, nothing bought', async () => {
    const layers = new ScriptedLayers(() => LAYERS);
    const { deps } = pureDeps(layers);
    expect(await roof3dAt(deps, [Number.NaN, 41.25], null)).toBeNull();
    expect(layers.calls).toHaveLength(0);
  });

  it('garbled layers (wrong CRS, mismatched arrays, all no-data, oversized): a typed "unusable", never a throw', async () => {
    const bad = [
      { ...LAYERS, epsg: 4326 },
      { ...LAYERS, raster: { ...LAYERS.raster, mask: LAYERS.raster.mask.subarray(10) } },
      { ...LAYERS, raster: { ...LAYERS.raster, dsm: new Float32Array(LAYERS.raster.dsm.length).fill(Number.NaN) } },
      { ...LAYERS, raster: { ...LAYERS.raster, width: 5000, height: 5000 } },
      { ...LAYERS, raster: { ...LAYERS.raster, pixelSizeM: Number.POSITIVE_INFINITY } },
      { ...LAYERS, originX: Number.NaN },
    ];
    for (const [i, layer] of bad.entries()) {
      const layers = new ScriptedLayers(() => layer);
      const { deps } = pureDeps(layers);
      const snap = await roof3dAt(deps, INSIDE, buildingOf(HOUSE));
      expect(snap, `case ${i}`).toMatchObject({ roof: null, none: 'unusable' });
    }
  });
});

