import { describe, expect, it } from 'vitest';
import { preparePhoto } from '../src/features/quote/measure/photo.ts';

/* The quote page's card photo goes through the measuring page's preparation (windows/preparePhoto.ts). */

const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

describe('quote card photo', () => {
  it('a JPEG under the limit goes as the camera made it (its EXIF with it)', async () => {
    const file = new File([new Uint8Array(JPEG_HEAD)], 'IMG_1.jpg', { type: 'image/jpeg' });
    const p = await preparePhoto(file, 12 * 1024 * 1024);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.blob).toBe(file);
  });

  it('something that is not a photo is refused as the wrong type', async () => {
    const p = await preparePhoto(new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' }), 12 * 1024 * 1024);
    expect(p).toEqual({ ok: false, reason: 'type' });
  });

  it('a photo over the company limit is too big', async () => {
    const file = new File([new Uint8Array([...JPEG_HEAD, ...new Array(2000).fill(0)])], 'IMG_2.jpg', { type: 'image/jpeg' });
    expect(await preparePhoto(file, 1000)).toEqual({ ok: false, reason: 'too-big' });
  });
});
