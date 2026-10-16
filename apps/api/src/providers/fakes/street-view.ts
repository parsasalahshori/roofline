import jpeg from 'jpeg-js';
import type { LngLat } from '@roofline/shared';
import { type StreetView, type StreetViewImageRequest, type StreetViewPano, StreetViewUnavailableError } from '../street-view.ts';

let plain: Uint8Array | null = null;

/** A made-up 640 x 640 street photo (made once): light sky over a darker street, with a soft check texture. */
export function plainJpeg(): Uint8Array {
  if (plain === null) {
    const w = 640;
    const h = 640;
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = (y < h / 2 ? 185 : 115) + (((x >> 5) + (y >> 5)) % 2 === 0 ? 18 : -18);
        const i = (y * w + x) * 4;
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
        data[i + 3] = 255;
      }
    }
    plain = new Uint8Array(jpeg.encode({ width: w, height: h, data }, 80).data);
  }
  return plain;
}

/**
 * Street View without the network. By default the camera stands `offsetM` metres south of the point asked about
 * (a street in front of the house) with imagery from 2023-06, and every photo is a made-up street picture. `none = true`
 * answers no imagery; `photo` replaces the JPEG; `pano` fixes the answer; `failNext(n)` throws.
 */
export class FakeStreetView implements StreetView {
  readonly configured = true;
  readonly calls: ({ method: 'metadata'; point: LngLat | string } | { method: 'image'; req: StreetViewImageRequest })[] = [];
  /** Set to answer per request instead (null: none there); `pano`, when set, still wins. */
  answer: ((where: LngLat | string) => StreetViewPano | null) | null = null;
  none = false;
  offsetM = 20;
  capturedOn: string | null = '2023-06';
  pano: StreetViewPano | null = null;
  photo: Uint8Array | null = null;
  private failures = 0;

  failNext(n = 1): void {
    this.failures += n;
  }

  private fail(): void {
    if (this.failures > 0) {
      this.failures--;
      throw new StreetViewUnavailableError('http', 'Fake Street View is unavailable.');
    }
  }

  /**
   * A point: a Google pano `offsetM` south of it. An address: none (the fake cannot look one up), so the point asked
   * about decides, as before.
   */
  async metadata(where: LngLat | string): Promise<StreetViewPano | null> {
    this.calls.push({ method: 'metadata', point: typeof where === 'string' ? where : [where[0], where[1]] });
    this.fail();
    if (this.none) return null;
    if (this.pano !== null) return structuredClone(this.pano);
    if (this.answer !== null) return this.answer(where);
    if (typeof where === 'string') return null;
    return { panoId: 'fake-pano', location: [where[0], where[1] - this.offsetM / 111_320], capturedOn: this.capturedOn, byGoogle: true };
  }

  async image(req: StreetViewImageRequest): Promise<Uint8Array> {
    this.calls.push({ method: 'image', req: { ...req } });
    this.fail();
    if (this.none) throw new StreetViewUnavailableError('no-image');
    return new Uint8Array(this.photo ?? plainJpeg());
  }
}
