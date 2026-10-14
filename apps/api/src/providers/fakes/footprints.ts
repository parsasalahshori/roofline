import { readFileSync } from 'node:fs';
import { quadkeyOf } from '@roofline/shared';
import type { FootprintFeature, FootprintSource } from '../footprints.ts';

export type FootprintCall = { method: 'tileUrls' | 'features'; args: { quadkey: string } };

let NE: FootprintFeature[] | null = null;
function loadNE(): FootprintFeature[] {
  NE ??= JSON.parse(
    readFileSync(new URL('../../../test/fixtures/footprints-ne.json', import.meta.url), 'utf8'),
  ) as FootprintFeature[];
  return NE;
}

/** The fixture buildings filed in the tile (by their first corner): the six Omaha ones are all in one tile. */
function inTile(quadkey: string): FootprintFeature[] {
  return loadNE().filter((f) => quadkeyOf(f.ring[0]![0], f.ring[0]![1], quadkey.length) === quadkey);
}

/** The NE fixture (six Omaha buildings), served from the tile they fall in; every other tile is empty. */
export class FakeFootprintSource implements FootprintSource {
  readonly configured = true;
  readonly calls: FootprintCall[] = [];
  private failures = 0;
  failNext(n = 1): void {
    this.failures = n;
  }
  private record(call: FootprintCall): void {
    this.calls.push(call);
    if (this.failures > 0) {
      this.failures--;
      throw new Error('Fake footprints failure');
    }
  }
  tileUrls(quadkey: string): Promise<string[]> {
    try {
      this.record({ method: 'tileUrls', args: { quadkey } });
    } catch (err) {
      return Promise.reject(err as Error);
    }
    return Promise.resolve(inTile(quadkey).length > 0 ? [`https://fake.test/footprints/${quadkey}.csv.gz`] : []);
  }
  async *features(quadkey: string): AsyncGenerator<FootprintFeature> {
    this.record({ method: 'features', args: { quadkey } });
    yield* inTile(quadkey);
  }
}
