import { describe, expect, test } from 'vitest';
import type { Config } from '../src/config.ts';
import { resvgCardFor } from '../src/providers/resvg-card.ts';
import { AD_CARD_LINE } from '../src/storm/creative.ts';

/* The real ad-card renderer (S1 Task 19): a 1080x1080 PNG. No database needed. */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function dimensions(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('resvgCardFor', () => {
  const renderer = resvgCardFor({} as Config);

  test('renders a 1080 x 1080 PNG', async () => {
    const png = await renderer.card({ companyName: 'Acme Roofing & Sons', line: AD_CARD_LINE, colorHex: '#1d4ed8' });
    expect(Array.from(png.slice(0, 8))).toEqual(SIGNATURE);
    expect(dimensions(png)).toEqual({ width: 1080, height: 1080 });
  });

  test('a very long name and markup characters still render', async () => {
    const png = await renderer.card({
      companyName: `<b>${'Extraordinarily Long Roofing Company Name '.repeat(4)}</b> "&"`,
      line: AD_CARD_LINE,
      colorHex: '#1d4ed8',
    });
    expect(Array.from(png.slice(0, 8))).toEqual(SIGNATURE);
    expect(dimensions(png)).toEqual({ width: 1080, height: 1080 });
  });
});
