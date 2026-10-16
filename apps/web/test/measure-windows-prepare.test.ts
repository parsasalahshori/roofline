// @vitest-environment node
import exifr from 'exifr';
import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import {
  exifApp1,
  heicExifLocation,
  PHOTO_MAX_BYTES,
  preparePhoto,
  readHeicExifItem,
  readJpegExif,
  sniffPhoto,
  withExif,
  type PhotoCodec,
} from '../src/features/measure/windows/preparePhoto.ts';

/* Getting a photo ready to upload: HEIC to JPEG where the browser can, over 12 MB smaller, the camera's focal length kept. */

const smallJpeg = () => new Uint8Array(jpeg.encode({ width: 8, height: 6, data: new Uint8Array(8 * 6 * 4).fill(200) }, 80).data);

/** A minimal HEIC: ftyp, meta (iinf with an "Exif" item, iloc pointing at it), mdat holding the Exif item. */
function fakeHeic(tiff: Uint8Array): Uint8Array {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const u16 = (n: number) => [(n >> 8) & 255, n & 255];
  const box = (type: string, body: number[]) => [...u32(8 + body.length), ...[...type].map((c) => c.charCodeAt(0)), ...body];
  const infe = (id: number, type: string) => box('infe', [2, 0, 0, 0, ...u16(id), ...u16(0), ...[...type].map((c) => c.charCodeAt(0)), 0]);
  const ftyp = box('ftyp', [...'heic'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'mif1heic'].map((c) => c.charCodeAt(0))));
  const iinf = box('iinf', [0, 0, 0, 0, ...u16(2), ...infe(1, 'hvc1'), ...infe(2, 'Exif')]);
  const exifItem = [0, 0, 0, 0, ...tiff];
  // iloc v0, offset 4 bytes, length 4 bytes, no base offset; the offset is patched in once the layout is known.
  const iloc = (offset: number) => box('iloc', [0, 0, 0, 0, 0x44, 0x00, ...u16(2), ...u16(1), ...u16(0), ...u16(1), ...u32(0), ...u32(0), ...u16(2), ...u16(0), ...u16(1), ...u32(offset), ...u32(exifItem.length)]);
  const meta = (offset: number) => box('meta', [0, 0, 0, 0, ...iinf, ...iloc(offset)]);
  const head = ftyp.length + meta(0).length + 8;
  return new Uint8Array([...ftyp, ...meta(head), ...box('mdat', exifItem)]);
}

const tiffOf = (app1: Uint8Array) => app1.subarray(10);

/** A browser stand-in: "draws" any photo as this JPEG (or cannot open it). */
const codec = (out: Uint8Array | null, calls: { side: number; quality: number }[] = []): PhotoCodec => ({
  toJpeg: async (_f, side, quality) => {
    calls.push({ side, quality });
    return out;
  },
});

describe('the EXIF the sizing needs survives the trip', () => {
  it('a fresh EXIF block carries the focal length and time, upright, and the server reads it back', async () => {
    const app1 = exifApp1({ focal35mm: 26, takenAt: '2026:10:16 09:30:00' });
    const j = withExif(smallJpeg(), app1);
    expect(sniffPhoto(j)).toBe('jpeg');
    expect(readJpegExif(j)).toEqual({ orientation: 1, focal35mm: 26, takenAt: '2026:10:16 09:30:00' });
    // What the server uses (exifr, the same three tags)
    const tags = (await exifr.parse(j, { pick: ['Orientation', 'FocalLengthIn35mmFormat', 'DateTimeOriginal'], translateValues: false, reviveValues: false })) as Record<string, unknown>;
    expect(tags).toMatchObject({ Orientation: 1, FocalLengthIn35mmFormat: 26, DateTimeOriginal: '2026:10:16 09:30:00' });
    // And the JPEG still decodes
    expect(jpeg.decode(j).width).toBe(8);
  });

  it('reads a HEIC\'s EXIF item (iinf + iloc)', () => {
    const h = fakeHeic(tiffOf(exifApp1({ focal35mm: 24, takenAt: '2026:10:16 10:00:00' })));
    expect(sniffPhoto(h)).toBe('heic');
    const at = heicExifLocation(h)!;
    expect(at).not.toBeNull();
    expect(readHeicExifItem(h.subarray(at.offset, at.offset + at.length))).toEqual({ orientation: 1, focal35mm: 24, takenAt: '2026:10:16 10:00:00' });
  });
});

describe('preparing a photo', () => {
  it('JPEG or PNG up to 12 MB: sent as it is', async () => {
    const f = new File([smallJpeg() as BlobPart], 'a.jpg', { type: 'image/jpeg' });
    const p = await preparePhoto(f, codec(null));
    expect(p).toEqual({ ok: true, file: f, converted: 'none' });
  });

  it('over 12 MB: drawn at 4032 px as JPEG, with the original focal length and time', async () => {
    const original = withExif(smallJpeg(), exifApp1({ focal35mm: 23, takenAt: '2026:10:16 11:00:00' }));
    const padded = new Uint8Array(PHOTO_MAX_BYTES + 1000);
    padded.set(original);
    const calls: { side: number; quality: number }[] = [];
    const p = await preparePhoto(new File([padded as BlobPart], 'IMG_1.jpg', { type: 'image/jpeg' }), codec(smallJpeg(), calls));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.converted).toBe('smaller');
    expect(calls[0]).toEqual({ side: 4032, quality: 0.92 });
    expect(p.file.size).toBeLessThanOrEqual(PHOTO_MAX_BYTES);
    expect(readJpegExif(new Uint8Array(await p.file.arrayBuffer()))).toMatchObject({ focal35mm: 23, takenAt: '2026:10:16 11:00:00' });
  });

  it('HEIC: converted where the browser opens it (focal length kept), refused where it cannot', async () => {
    const h = fakeHeic(tiffOf(exifApp1({ focal35mm: 26, takenAt: null })));
    const file = new File([h as BlobPart], 'IMG_2.HEIC', { type: 'image/heic' });
    const safari = await preparePhoto(file, codec(smallJpeg()));
    expect(safari.ok && safari.converted).toBe('heic');
    if (safari.ok) {
      expect(safari.file.name).toBe('IMG_2.jpg');
      expect(safari.file.type).toBe('image/jpeg');
      expect(readJpegExif(new Uint8Array(await safari.file.arrayBuffer()))?.focal35mm).toBe(26);
    }
    expect(await preparePhoto(file, codec(null))).toEqual({ ok: false, reason: 'heic' });
  });

  it('not a photo: refused', async () => {
    expect(await preparePhoto(new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' }), codec(null))).toEqual({ ok: false, reason: 'type' });
  });
});
