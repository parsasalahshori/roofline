import type { LngLat, Ring, SolarBuilding } from '@roofline/shared';
import type { AppDeps } from '../../src/app.ts';
import { onRoof3dEvent, type Roof3dEvent } from '../../src/estimator/roof-3d-events.ts';
import type { RoofLayers, SolarLayersApi } from '../../src/providers/solar-layers.ts';

/*
 * The parts of AppDeps the roof in 3D uses, with no database and no network: a scripted Data Layers, a fixed clock, no
 * file store, a config with only what roof-3d.ts reads. Every roof-3d event and logged error is collected.
 */

export const NOW = new Date('2026-10-12T15:00:00.000Z');

/** Data Layers answered by a script: (centre, radius, call number from 0) -> layers, null, or a thrown error. */
export class ScriptedLayers implements SolarLayersApi {
  readonly configured = true;
  readonly calls: { center: LngLat; radiusM: number }[] = [];
  constructor(private readonly answer: (center: LngLat, radiusM: number, n: number) => Promise<RoofLayers | null> | RoofLayers | null) {}
  async roofLayers(center: LngLat, radiusM: number): Promise<RoofLayers | null> {
    this.calls.push({ center: [center[0], center[1]], radiusM });
    return this.answer(center, radiusM, this.calls.length - 1);
  }
}

export function pureDeps(solarLayers: SolarLayersApi, o: { mode?: 'off' | 'shadow' | 'on' } = {}): { deps: AppDeps; events: Roof3dEvent[]; errors: unknown[] } {
  const events: Roof3dEvent[] = [];
  const errors: unknown[] = [];
  const deps = {
    solarLayers,
    clock: { now: () => NOW },
    objectStore: { configured: false },
    config: { ROOF_3D_MODE: o.mode ?? 'on', NODE_ENV: 'test' },
    logError: (err: unknown) => errors.push(err),
  } as unknown as AppDeps;
  onRoof3dEvent(deps, (e) => events.push(e));
  return { deps, events, errors };
}

/** Google's building for a lng/lat rectangle: its box, centre and no segments. */
export function buildingOf(ring: Ring): SolarBuilding {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const sw: LngLat = [Math.min(...lngs), Math.min(...lats)];
  const ne: LngLat = [Math.max(...lngs), Math.max(...lats)];
  return { center: [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2], box: { sw, ne }, imageryQuality: 'HIGH', imageryDate: '2024-05-01', segments: [] };
}

/** The layers with `m` metres cut off one side (as if bought round another house whose grid ends there). */
export function cropLayers(layers: RoofLayers, side: 'east' | 'west' | 'north' | 'south', m: number): RoofLayers {
  const { width: W, height: H, pixelSizeM: s } = layers.raster;
  const cut = Math.round(m / s);
  const c0 = side === 'west' ? cut : 0;
  const c1 = side === 'east' ? W - cut : W;
  const r0 = side === 'north' ? cut : 0;
  const r1 = side === 'south' ? H - cut : H;
  const w = c1 - c0;
  const h = r1 - r0;
  const dsm = new Float32Array(w * h);
  const mask = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    dsm.set(layers.raster.dsm.subarray((r + r0) * W + c0, (r + r0) * W + c1), r * w);
    mask.set(layers.raster.mask.subarray((r + r0) * W + c0, (r + r0) * W + c1), r * w);
  }
  return {
    ...layers,
    raster: { width: w, height: h, pixelSizeM: s, dsm, mask },
    photo: null,
    originX: layers.originX + c0 * s,
    originY: layers.originY - r0 * s,
  };
}
