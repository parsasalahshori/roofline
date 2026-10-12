import { readFileSync } from 'node:fs';
import type { FootprintFeature, FootprintSource } from '../footprints.ts';

export type FootprintCall = { method: 'stateFileUrl' | 'features'; args: { state: string } };

let NE: FootprintFeature[] | null = null;
function loadNE(): FootprintFeature[] {
  NE ??= JSON.parse(
    readFileSync(new URL('../../../test/fixtures/footprints-ne.json', import.meta.url), 'utf8'),
  ) as FootprintFeature[];
  return NE;
}

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
  stateFileUrl(state: string): string {
    this.record({ method: 'stateFileUrl', args: { state } });
    return `https://fake.test/footprints/${state}.zip`;
  }
  async *features(state: string): AsyncGenerator<FootprintFeature> {
    this.record({ method: 'features', args: { state } });
    if (state.toUpperCase() === 'NE') yield* loadNE();
  }
}
