import type { StreetImageView } from '@roofline/shared';
import { PropertyDataUnavailableError } from '../property-data.ts';
import type { StreetImagery } from '../street-imagery.ts';

/** Street imagery with no network: no photo anywhere unless a test sets `image`; `failNext` makes a lookup fail. */
export class FakeStreetImagery implements StreetImagery {
  readonly configured = true;
  readonly calls: { lat: number; lng: number }[] = [];
  image: StreetImageView | null = null;
  private failures = 0;

  failNext(n = 1): void {
    this.failures += n;
  }

  async nearest(point: { lat: number; lng: number }): Promise<StreetImageView | null> {
    this.calls.push(point);
    if (this.failures > 0) {
      this.failures--;
      throw new PropertyDataUnavailableError('Fake street imagery is unavailable.');
    }
    return this.image;
  }
}
