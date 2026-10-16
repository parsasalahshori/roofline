import jpeg from 'jpeg-js';
import type { Quad } from '@roofline/shared';

/*
 * A synthetic on-site window photo: a 36 x 60 in window (dark frame, grey glass) with a US letter sheet (8.5 x 11 in)
 * taped to the glass, seen by a phone camera turned `yawDeg` off square at `distanceM`. Rendered as displayed; stored
 * as a JPEG with an EXIF block (focal length, capture time, orientation). With `orientation` 6 the stored pixels are
 * the displayed ones turned a quarter anticlockwise, as a phone held upright writes them; the corners are always in
 * the displayed frame (what a browser shows).
 */

export const WINDOW_IN = { w: 36, h: 60 };
const PAPER = { u0: 10, v0: 18, w: 8.5, h: 11 };
const IN = 0.0254;

export type WindowPhotoFixture = {
  bytes: Uint8Array;
  widthPx: number;
  heightPx: number;
  window: Quad;
  paper: Quad;
  /** The measuring sheet's matched points if it lay where the paper is (a 4 x 5 grid on the paper, inches from its corner). */
  sheet: { imagePoints: [number, number][]; sheetPointsIn: [number, number][] };
  /** The window's corners on a frame `offsetIn` in front of the glass (toward the camera). */
  windowAt(offsetIn: number): Quad;
};

/** An EXIF APP1 segment: Orientation (IFD0), and in the Exif IFD FocalLengthIn35mmFilm and DateTimeOriginal. */
export function exifSegment(o: { orientation?: number; focal35mm?: number; takenAt?: string }): Uint8Array {
  const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => (n >> (8 * i)) & 0xff);
  const ifd0: number[][] = [];
  if (o.orientation !== undefined) ifd0.push([0x0112, 3, 1, o.orientation]);
  const exifEntries: { tag: number; type: number; count: number; value: number | number[] }[] = [];
  if (o.focal35mm !== undefined) exifEntries.push({ tag: 0xa405, type: 3, count: 1, value: o.focal35mm });
  const date = o.takenAt !== undefined ? [...Buffer.from(o.takenAt, 'ascii'), 0] : null;
  if (date !== null) exifEntries.push({ tag: 0x9003, type: 2, count: date.length, value: date });
  // Layout: header(8) | IFD0 | Exif IFD | data
  const ifd0Count = ifd0.length + 1; // + ExifIFD pointer
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifOffset = 8 + ifd0Size;
  const exifSize = 2 + exifEntries.length * 12 + 4;
  const dataOffset = exifOffset + exifSize;
  const out: number[] = [0x49, 0x49, 0x2a, 0x00, ...le(8, 4)];
  out.push(...le(ifd0Count, 2));
  for (const [tag, type, count, value] of ifd0) out.push(...le(tag!, 2), ...le(type!, 2), ...le(count!, 4), ...le(value!, 2), 0, 0);
  out.push(...le(0x8769, 2), ...le(4, 2), ...le(1, 4), ...le(exifOffset, 4));
  out.push(...le(0, 4));
  const data: number[] = [];
  out.push(...le(exifEntries.length, 2));
  for (const e of exifEntries) {
    out.push(...le(e.tag, 2), ...le(e.type, 2), ...le(e.count, 4));
    if (Array.isArray(e.value)) {
      out.push(...le(dataOffset + data.length, 4));
      data.push(...e.value);
    } else out.push(...le(e.value, 2), 0, 0);
  }
  out.push(...le(0, 4));
  out.push(...data);
  const payload = [...Buffer.from('Exif\0\0', 'binary'), ...out];
  const len = payload.length + 2;
  return Uint8Array.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

/** Inserts an APP1 segment right after the JPEG's SOI. */
export function withExif(jpg: Uint8Array, app1: Uint8Array): Uint8Array {
  return Uint8Array.from([...jpg.subarray(0, 2), ...app1, ...jpg.subarray(2)]);
}

export function windowPhoto(o: { widthPx?: number; heightPx?: number; yawDeg?: number; distanceM?: number; focal35mm?: number; orientation?: 1 | 6; exif?: boolean } = {}): WindowPhotoFixture {
  const W = o.widthPx ?? 900;
  const H = o.heightPx ?? 1200;
  const yaw = ((o.yawDeg ?? 25) * Math.PI) / 180;
  const D = o.distanceM ?? 2.2;
  const focal35 = o.focal35mm ?? 26;
  const f = (focal35 / 36) * Math.max(W, H);
  const e1 = [Math.cos(yaw), 0, Math.sin(yaw)];
  // The wall's second direction is straight down: image y is down, world y is down.
  // The window's middle straight ahead of the camera.
  const C = [-(WINDOW_IN.w / 2) * IN * e1[0]!, -(WINDOW_IN.h / 2) * IN, D - (WINDOW_IN.w / 2) * IN * e1[2]!];
  const project = (u: number, v: number): [number, number] => {
    const P = [C[0]! + u * IN * e1[0]!, C[1]! + v * IN, C[2]! + u * IN * e1[2]!];
    return [W / 2 + (f * P[0]!) / P[2]!, H / 2 + (f * P[1]!) / P[2]!];
  };
  const quad = (u0: number, v0: number, w: number, h: number): Quad => [project(u0, v0), project(u0 + w, v0), project(u0 + w, v0 + h), project(u0, v0 + h)];
  // Toward the camera from the wall is minus its normal e1 x e2 = (-sin, 0, cos).
  const projectAt = (u: number, v: number, off: number): [number, number] => {
    const P = [C[0]! + u * IN * e1[0]! + off * IN * Math.sin(yaw), C[1]! + v * IN, C[2]! + u * IN * e1[2]! - off * IN * Math.cos(yaw)];
    return [W / 2 + (f * P[0]!) / P[2]!, H / 2 + (f * P[1]!) / P[2]!];
  };
  const sheetPointsIn: [number, number][] = [];
  for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) sheetPointsIn.push([0.75 + c * 2.3, 0.75 + r * 2.35]);
  const sheet = { imagePoints: sheetPointsIn.map(([x, y]) => project(PAPER.u0 + x, PAPER.v0 + y)), sheetPointsIn };
  const windowAt = (off: number): Quad => [projectAt(0, 0, off), projectAt(WINDOW_IN.w, 0, off), projectAt(WINDOW_IN.w, WINDOW_IN.h, off), projectAt(0, WINDOW_IN.h, off)];
  const shade = (x: number, y: number): number => {
    // Ray (a, b, 1) meets the plane C + u e1 + v e2: solve for u, v.
    const a = (x - W / 2) / f;
    const b = (y - H / 2) / f;
    // t*a = C0 + u*e1x ; t*b = C1 + v ; t = C2 + u*e1z
    const u = (a * C[2]! - C[0]!) / (e1[0]! - a * e1[2]!);
    const t = C[2]! + u * e1[2]!;
    const v = t * b - C[1]!;
    const ui = u / IN;
    const vi = v / IN;
    if (ui >= PAPER.u0 && ui <= PAPER.u0 + PAPER.w && vi >= PAPER.v0 && vi <= PAPER.v0 + PAPER.h) return 245;
    if (ui >= 0 && ui <= WINDOW_IN.w && vi >= 0 && vi <= WINDOW_IN.h) return 120;
    if (ui >= -3 && ui <= WINDOW_IN.w + 3 && vi >= -3 && vi <= WINDOW_IN.h + 3) return 40;
    return 190;
  };
  const rotated = o.orientation === 6;
  // Stored grid: as displayed, or turned a quarter anticlockwise (orientation 6 turns it back clockwise to display).
  const SW = rotated ? H : W;
  const SH = rotated ? W : H;
  const data = new Uint8Array(SW * SH * 4);
  for (let sy = 0; sy < SH; sy++) {
    for (let sx = 0; sx < SW; sx++) {
      // Orientation 6 displays stored (sx, sy) at (SH - 1 - sy, sx).
      const [x, y] = rotated ? [SH - 1 - sy, sx] : [sx, sy];
      const v = shade(x + 0.5, y + 0.5);
      const i = (sy * SW + sx) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  let bytes: Uint8Array = new Uint8Array(jpeg.encode({ width: SW, height: SH, data }, 92).data);
  if (o.exif !== false) bytes = withExif(bytes, exifSegment({ orientation: o.orientation ?? 1, focal35mm: o.focal35mm === undefined ? undefined : focal35, takenAt: '2026:10:15 10:30:00' }));
  return { bytes, widthPx: W, heightPx: H, window: quad(0, 0, WINDOW_IN.w, WINDOW_IN.h), paper: quad(PAPER.u0, PAPER.v0, PAPER.w, PAPER.h), sheet, windowAt };
}
