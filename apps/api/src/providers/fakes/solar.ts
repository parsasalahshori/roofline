import type { LngLat, SolarBuilding } from '@roofline/shared';
import { DEMO_LOOKUP_LOTS } from '../../demo/places.ts';
import { type SolarApi, SolarUnavailableError } from '../solar.ts';

/**
 * Google Solar without the network. It records each lookup and answers what a test set for the nearest point
 * (`set`, within 60 m, like Google's 50 m search plus room), else no building. `failNext(n)` makes the next n
 * lookups throw SolarUnavailableError.
 */
export class FakeSolar implements SolarApi {
  readonly configured = true;
  readonly calls: LngLat[] = [];
  private readonly answers: { at: LngLat; building: SolarBuilding }[] = [];
  private failures = 0;

  set(at: LngLat, building: SolarBuilding): void {
    this.answers.push({ at, building });
  }

  /** Forgets every answer set so far (a test then sets the one it wants). */
  clear(): void {
    this.answers.length = 0;
  }

  failNext(n = 1): void {
    this.failures += n;
  }

  async buildingInsights(point: LngLat): Promise<SolarBuilding | null> {
    this.calls.push([point[0], point[1]]);
    if (this.failures > 0) {
      this.failures--;
      throw new SolarUnavailableError('Fake Solar is unavailable.');
    }
    const cos = Math.cos((point[1] * Math.PI) / 180);
    let best: { d: number; building: SolarBuilding } | null = null;
    for (const a of this.answers) {
      const d = Math.hypot((a.at[0] - point[0]) * 111_320 * cos, (a.at[1] - point[1]) * 111_320);
      if (d <= 60 && (best === null || d < best.d)) best = { d, building: a.building };
    }
    return best === null ? null : structuredClone(best.building);
  }
}

/**
 * Google Solar for the demo without a Solar key: a recent HIGH-imagery building at every point, so the demo's roofs are
 * measured from satellite as before, except at every eighth lookup lot (see DEMO_LOOKUP_LOTS), whose imagery is LOW and
 * from 2014: those homes show the "we can't measure your roof from satellite images" path. No network.
 */
export class DemoSolar implements SolarApi {
  readonly configured = true;

  /** Whether the demo lot at this point has the old, low-quality imagery. */
  static oldImageryAt(point: readonly [number, number]): boolean {
    const i = DEMO_LOOKUP_LOTS.findIndex((l) => Math.abs(l[0] - point[0]) < 1e-6 && Math.abs(l[1] - point[1]) < 1e-6);
    return i >= 0 && i % 8 === 7;
  }

  async buildingInsights(point: readonly [number, number]): Promise<SolarBuilding | null> {
    const old = DemoSolar.oldImageryAt(point);
    const recent = new Date(Date.now() - 1.5 * 365.25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    return {
      center: [point[0], point[1]],
      box: { sw: [point[0] - 0.00015, point[1] - 0.0001], ne: [point[0] + 0.00015, point[1] + 0.0001] },
      imageryQuality: old ? 'LOW' : 'HIGH',
      imageryDate: old ? '2014-06-12' : recent,
      segments: [{ pitchDeg: 26.6, azimuthDeg: 180, areaM2: 200, groundAreaM2: 180, center: [point[0], point[1]], box: null }],
    };
  }
}
