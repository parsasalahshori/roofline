import type { StaticMap } from '../static-map.ts';

/** A 1x1 PNG. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'),
);

/** Records each call and answers a tiny PNG; `absent = true` answers null (no map). No network. */
export class FakeStaticMap implements StaticMap {
  readonly calls: { center: [number, number]; path?: [number, number][] }[] = [];
  absent = false;
  async image(input: { center: [number, number]; path?: [number, number][] }): Promise<Uint8Array | null> {
    this.calls.push(input);
    return this.absent ? null : new Uint8Array(TINY_PNG);
  }
}
