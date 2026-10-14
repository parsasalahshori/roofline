import type { LngLat } from '@roofline/shared';
import { type RoofLayers, type SolarLayersApi, SolarLayersUnavailableError } from '../solar-layers.ts';

/**
 * Google Solar Data Layers without the network. It records each request (centre and radius) and answers the layers a
 * test set (`set`) whose grid covers the requested centre, else null (no imagery there). `failNext(n)` makes the
 * next n requests throw SolarLayersUnavailableError. The demo without a Solar key uses it too: no imagery anywhere,
 * so every roof is guessed from its outline as before.
 */
export class FakeSolarLayers implements SolarLayersApi {
  readonly configured = true;
  readonly calls: { center: LngLat; radiusM: number }[] = [];
  private readonly answers: { covers: (center: LngLat) => boolean; layers: RoofLayers }[] = [];
  private failures = 0;

  /** Answers `layers` for any request whose centre `covers` accepts. */
  set(covers: (center: LngLat) => boolean, layers: RoofLayers): void {
    this.answers.push({ covers, layers });
  }

  failNext(n = 1): void {
    this.failures += n;
  }

  async roofLayers(center: LngLat, radiusM: number): Promise<RoofLayers | null> {
    this.calls.push({ center: [center[0], center[1]], radiusM });
    if (this.failures > 0) {
      this.failures--;
      throw new SolarLayersUnavailableError('Fake Solar layers are unavailable.');
    }
    const hit = this.answers.find((a) => a.covers(center));
    return hit === undefined ? null : hit.layers;
  }
}
