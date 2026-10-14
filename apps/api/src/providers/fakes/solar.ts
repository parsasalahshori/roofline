import type { LngLat, SolarBuilding } from '@roofline/shared';
import { type SolarApi, SolarUnavailableError } from '../solar.ts';

/**
 * Google Solar without the network. It records each lookup and answers what a test set for the nearest point
 * (`set`, within 60 m, like Google's 50 m search plus room), else no building. `failNext(n)` makes the next n
 * lookups throw SolarUnavailableError. The demo without a Solar key uses it too: no building anywhere.
 */
export class FakeSolar implements SolarApi {
  readonly configured = true;
  readonly calls: LngLat[] = [];
  private readonly answers: { at: LngLat; building: SolarBuilding }[] = [];
  private failures = 0;

  set(at: LngLat, building: SolarBuilding): void {
    this.answers.push({ at, building });
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
