import type { AdImageRenderer } from '../ad-image.ts';

/** Returns only the 8 PNG signature bytes. */
export class FakeAdImageRenderer implements AdImageRenderer {
  readonly calls: { method: string; args: unknown[] }[] = [];
  async card(i: { companyName: string; line: string; colorHex: string }): Promise<Uint8Array> {
    this.calls.push({ method: 'card', args: [i] });
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
}
