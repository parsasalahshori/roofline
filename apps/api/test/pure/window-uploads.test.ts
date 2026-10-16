import { describe, expect, it } from 'vitest';
import { focalPxFrom35mm, type Quad, sizeFromKnownSide, sizeFromReference } from '@roofline/shared';
import { arProblem, quadIsGood, readImageInfo, sizePhotoWindow, sniff, viewingAngleDeg } from '../../src/estimator/window-uploads.ts';
import { exifSegment, windowPhoto, WINDOW_IN, withExif } from '../window-photo-fixture.ts';

/* On-site window photos: reading the photo (type by its bytes, displayed size, EXIF) and sizing a window from it. */

const within = (got: number, want: number, share = 0.02) => expect(Math.abs(got - want) / want).toBeLessThan(share);

describe('reading an uploaded photo', () => {
  it('a JPEG with EXIF: displayed size, focal length, capture time', async () => {
    const f = windowPhoto({ widthPx: 300, heightPx: 400, focal35mm: 28 });
    expect(await readImageInfo(f.bytes)).toEqual({ kind: 'jpeg', widthPx: 300, heightPx: 400, orientation: 1, focal35mm: 28, takenAt: '2026-10-15T10:30:00' });
  });

  it('no EXIF: no focal length, no time', async () => {
    const f = windowPhoto({ widthPx: 300, heightPx: 400, exif: false });
    expect(await readImageInfo(f.bytes)).toMatchObject({ widthPx: 300, heightPx: 400, orientation: 1, focal35mm: null, takenAt: null });
  });

  it('orientation 6 (a phone held upright): sizes are reported as displayed', async () => {
    const f = windowPhoto({ widthPx: 300, heightPx: 400, orientation: 6 });
    const info = await readImageInfo(f.bytes);
    expect(info).toMatchObject({ widthPx: 300, heightPx: 400, orientation: 6 });
  });

  it('types by their bytes: PNG, HEIC, and anything else', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0, 0, 0, 0, 200, 8, 2, 0, 0, 0]);
    expect(await readImageInfo(png)).toMatchObject({ kind: 'png', widthPx: 256, heightPx: 200, focal35mm: null });
    const heic = Uint8Array.from([0, 0, 0, 24, ...Buffer.from('ftypheic'), 0, 0, 0, 0]);
    expect(sniff(heic)).toBe('heic');
    expect(await readImageInfo(heic)).toBe('heic');
    expect(await readImageInfo(Buffer.from('<html>not a photo</html>'))).toBeNull();
    // A JPEG header with a broken EXIF block still reads (no EXIF used).
    const f = windowPhoto({ widthPx: 100, heightPx: 120, exif: false });
    const broken = withExif(f.bytes, Uint8Array.from([0xff, 0xe1, 0, 10, ...Buffer.from('Exif\0\0'), 1, 2]));
    expect(await readImageInfo(broken)).toMatchObject({ widthPx: 100, heightPx: 120, focal35mm: null });
    expect(exifSegment({}).length).toBeGreaterThan(10);
  });
});

describe('sizing a photographed window', () => {
  const photo = windowPhoto({ yawDeg: 25 });
  const upload = { widthPx: photo.widthPx, heightPx: photo.heightPx, focal35mm: null };

  it('with a letter sheet on the glass: 36 x 60 in within 2%, the same as the shared math', () => {
    const w = sizePhotoWindow({ id: 'w1', uploadId: 'u', corners: photo.window, scale: { kind: 'reference', reference: 'letter', corners: photo.paper } }, upload)!;
    within(w.widthIn, WINDOW_IN.w);
    within(w.heightIn, WINDOW_IN.h);
    const shared = sizeFromReference(photo.window, photo.paper, 8.5, 11)!;
    expect(w.widthIn).toBeCloseTo(shared.widthIn, 1);
    expect(w).toMatchObject({ sizeClass: 'standard', quality: 'good' });
  });

  it('with the measuring sheet and no focal length in the photo: the ± is wider than with one (26 mm assumed)', () => {
    const input = { id: 'w1', uploadId: 'u', corners: photo.window, scale: { kind: 'sheet' as const, paper: 'letter' as const, imagePoints: photo.sheet.imagePoints, sheetPointsIn: photo.sheet.sheetPointsIn, planeOffsetIn: 0 } };
    const known = sizePhotoWindow(input, { ...upload, focal35mm: 26 })!;
    const assumed = sizePhotoWindow(input, upload)!;
    expect(assumed.widthIn).toBe(known.widthIn);
    expect(assumed.uncertaintyIn!.width + assumed.uncertaintyIn!.height).toBeGreaterThan(known.uncertaintyIn!.width + known.uncertaintyIn!.height);
  });

  it('with one side measured: the other side from the corners and the focal length', () => {
    const w = sizePhotoWindow({ id: 'w1', uploadId: 'u', corners: photo.window, scale: { kind: 'known-side', side: 'width', inches: 36 } }, upload)!;
    within(w.heightIn, WINDOW_IN.h);
    const f = focalPxFrom35mm(26, photo.widthPx, photo.heightPx);
    expect(w.heightIn).toBeCloseTo(sizeFromKnownSide(photo.window, photo.widthPx, photo.heightPx, 'width', 36, f)!.heightIn, 1);
  });

  it('a paper held sideways is read sideways', () => {
    const p = photo.paper;
    const sideways: Quad = [p[3], p[0], p[1], p[2]]; // the same corners, marked a quarter turn round
    const w = sizePhotoWindow({ id: 'w1', uploadId: 'u', corners: [photo.window[3], photo.window[0], photo.window[1], photo.window[2]], scale: { kind: 'reference', reference: 'letter', corners: sideways } }, upload)!;
    within(w.widthIn, WINDOW_IN.h);
    within(w.heightIn, WINDOW_IN.w);
  });

  it("'check' for a steep, tiny or crossed quad; null when it cannot be sized", () => {
    const steep = windowPhoto({ yawDeg: 60 });
    const s = sizePhotoWindow({ id: 'w', uploadId: 'u', corners: steep.window, scale: { kind: 'reference', reference: 'letter', corners: steep.paper } }, upload);
    expect(s?.quality).toBe('check');
    const f = focalPxFrom35mm(26, photo.widthPx, photo.heightPx);
    expect(Math.abs(viewingAngleDeg(photo.window, photo.widthPx, photo.heightPx, f)! - 25)).toBeLessThan(2);
    expect(Math.abs(viewingAngleDeg(steep.window, steep.widthPx, steep.heightPx, f)! - 60)).toBeLessThan(2);
    expect(quadIsGood([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false);
    expect(quadIsGood([[0, 0], [100, 100], [100, 0], [0, 100]])).toBe(false);
    const line: Quad = [[0, 0], [10, 10], [20, 20], [30, 30]];
    expect(sizePhotoWindow({ id: 'w', uploadId: 'u', corners: photo.window, scale: { kind: 'reference', reference: 'letter', corners: line } }, upload)).toBeNull();
  });
});

describe('a window measured in AR (Android WebXR)', () => {
  const m = 0.0254;
  const pts = (w: number, h: number): [number, number, number][] => [[-w / 2 * m, h / 2 * m, -2], [w / 2 * m, h / 2 * m, -2], [w / 2 * m, -h / 2 * m, -2], [-w / 2 * m, -h / 2 * m, -2]];
  const input = (w: number, h: number, lost = 0) => ({
    id: 'a1',
    uploadId: 'u',
    corners: [[150, 200], [750, 200], [750, 1000], [150, 1000]] as Quad,
    scale: { kind: 'ar' as const, pointsM: pts(w, h) as [[number, number, number], [number, number, number], [number, number, number], [number, number, number]], trackingLostCount: lost },
  });
  const photo = { widthPx: 900, heightPx: 1200, focal35mm: null };

  it('is sized from the 3D points (the photo does not matter), to 0.01 in, with the AR ±', () => {
    const w = sizePhotoWindow(input(30.25, 48.5), photo)!;
    expect(w.widthIn).toBe(30.25);
    expect(w.heightIn).toBe(48.5);
    expect(w.quality).toBe('good');
    expect(w.uncertaintyIn).toEqual({ width: 0.12, height: 0.12 });
    expect(w.sizeClass).toBe('standard');
  });

  it('AR losing the wall more than 3 times makes it check', () => {
    expect(sizePhotoWindow(input(30, 48, 3), photo)!.quality).toBe('good');
    expect(sizePhotoWindow(input(30, 48, 4), photo)!.quality).toBe('check');
  });

  it('sizes outside 6..200 in are refused with a reason', () => {
    expect(arProblem(input(30, 48))).toBeNull();
    expect(arProblem(input(5, 48))).toMatch(/outside 6 to 200 in/);
    expect(arProblem(input(30, 201))).toMatch(/outside 6 to 200 in/);
    expect(sizePhotoWindow(input(5, 48), photo)).toBeNull();
  });
});
