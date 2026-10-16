// The engine over REAL photos with tape-measured truths:
//   npx tsx scripts/window-photo-bench/real.ts <folder> [truths.csv]   (default <folder>/truths.csv)
// CSV header (one row per photo; several photos of one window share `window`):
//   photo,window,true_width_in,true_height_in,offset_in,tl_x,tl_y,tr_x,tr_y,br_x,br_y,bl_x,bl_y
// - photo: file name in the folder (JPEG; EXIF orientation is applied, the focal length read from EXIF);
// - offset_in: how far the measured frame sits in front of (+) or behind (-) the glass the sheet is on;
// - tl_x..bl_y: the window's corners in the photo as DISPLAYED (orientation applied), pixels; rough is fine (they are
//   snapped; the 'as given' row shows what the corners alone give).
// Prints the same error table as the synthetic benchmark, plus one line per photo.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import exifr from 'exifr';
import jpeg from 'jpeg-js';
import { combineSheetMeasurements, DEFAULT_FOCAL_35MM, focalPxFrom35mm, measureWithSheet, type Quad, type RgbaImage } from '@roofline/shared';
import { detectSheetSync } from '../../apps/web/src/features/measure/windows/cv/detect-sheet.ts';
import { snapQuadSync } from '../../apps/web/src/features/measure/windows/cv/snap-quad.ts';
import { type Row, table } from './report.ts';

/** Pixels as displayed: EXIF orientation 1-8 applied. */
export function orient(img: RgbaImage, o: number): RgbaImage {
  if (o <= 1 || o > 8) return img;
  const { width: W, height: H, data } = img;
  const swap = o >= 5;
  const w = swap ? H : W;
  const h = swap ? W : H;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Source pixel for displayed (x, y).
      let sx: number;
      let sy: number;
      switch (o) {
        case 2: sx = W - 1 - x; sy = y; break;
        case 3: sx = W - 1 - x; sy = H - 1 - y; break;
        case 4: sx = x; sy = H - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = H - 1 - x; break;
        case 7: sx = W - 1 - y; sy = H - 1 - x; break;
        default: sx = W - 1 - y; sy = x; break; // 8
      }
      const i = (sy * W + sx) * 4;
      const j = (y * w + x) * 4;
      out[j] = data[i]!;
      out[j + 1] = data[i + 1]!;
      out[j + 2] = data[i + 2]!;
      out[j + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

async function main() {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error('usage: real.ts <folder> [truths.csv]');
    process.exit(2);
  }
  const csv = readFileSync(process.argv[3] ?? path.join(folder, 'truths.csv'), 'utf8').trim().split(/\r?\n/);
  const head = csv[0]!.split(',').map((s) => s.trim());
  const col = (name: string) => head.indexOf(name);
  type Res = { window: string; w: number; h: number; given: [number, number] | null; snap: [number, number] | null; snapOff: [number, number] | null };
  const res: Res[] = [];
  for (const line of csv.slice(1)) {
    const c = line.split(',').map((s) => s.trim());
    const file = path.join(folder, c[col('photo')]!);
    const bytes = readFileSync(file);
    const tags = ((await exifr.parse(bytes, { pick: ['Orientation', 'FocalLengthIn35mmFormat'], translateValues: false }).catch(() => null)) ?? {}) as Record<string, number>;
    const dec = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 4096 });
    const img = orient({ width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength) }, tags.Orientation ?? 1);
    const focal35 = tags.FocalLengthIn35mmFormat ?? DEFAULT_FOCAL_35MM;
    const focalPx = focalPxFrom35mm(focal35, img.width, img.height);
    const num = (n: string) => Number(c[col(n)]);
    const quad: Quad = [
      [num('tl_x'), num('tl_y')],
      [num('tr_x'), num('tr_y')],
      [num('br_x'), num('br_y')],
      [num('bl_x'), num('bl_y')],
    ];
    const offset = num('offset_in');
    const t0 = Date.now();
    const det = detectSheetSync(img);
    const snap = snapQuadSync(img, quad);
    const ms = Date.now() - t0;
    const m = (q: Quad, off: number) => {
      if (det === null) return null;
      const r = measureWithSheet({ widthPx: img.width, heightPx: img.height, focalPx, imagePoints: det.imagePoints, sheetPointsIn: det.sheetPointsIn, windowQuad: q, planeOffsetIn: off, cornerSigmaPx: snap.cornerSigmaPx });
      return r === null ? null : ([r.widthIn, r.heightIn] as [number, number]);
    };
    const r: Res = { window: c[col('window')] ?? c[col('photo')]!, w: num('true_width_in'), h: num('true_height_in'), given: m(quad, offset), snap: m(snap.quad, 0), snapOff: m(snap.quad, offset) };
    res.push(r);
    const fmt = (v: [number, number] | null) => (v === null ? 'refused' : `${v[0].toFixed(3)} x ${v[1].toFixed(3)}`);
    console.log(`${c[col('photo')]}: ${img.width}x${img.height} focal ${focal35} mm, sheet ${det === null ? 'NOT FOUND' : `${det.paper} ${det.imagePoints.length} pts RMS ${det.rmsErrorPx.toFixed(2)} px`}, snap confidence ${snap.sideConfidence.map((x) => x.toFixed(2)).join('/')} rivals ${snap.rivals.join('')}, ${ms} ms -> ${fmt(r.snapOff)} (true ${r.w} x ${r.h})`);
  }
  const row = (name: string, pick: (r: Res) => [number, number] | null): Row => {
    const ok = res.filter((r) => pick(r) !== null);
    return { method: name, errW: ok.map((r) => pick(r)![0] - r.w), errH: ok.map((r) => pick(r)![1] - r.h), refused: res.length - ok.length, total: res.length };
  };
  const rows = [row('sheet, corners as given, offset corrected', (r) => r.given), row('sheet + snapping, no offset correction', (r) => r.snap), row('sheet + snapping + offset correction', (r) => r.snapOff)];
  const groups = new Map<string, Res[]>();
  for (const r of res) groups.set(r.window, [...(groups.get(r.window) ?? []), r]);
  const cw: number[] = [];
  const ch: number[] = [];
  let refused = 0;
  for (const g of groups.values()) {
    const c = combineSheetMeasurements(g.filter((r) => r.snapOff !== null).map((r) => ({ widthIn: r.snapOff![0], heightIn: r.snapOff![1] })));
    if (c === null) refused++;
    else {
      cw.push(c.widthIn - g[0]!.w);
      ch.push(c.heightIn - g[0]!.h);
    }
  }
  rows.push({ method: 'combined per window (median of its photos)', errW: cw, errH: ch, refused, total: groups.size });
  console.log('\n' + table(`Real photos (${res.length} photos, ${groups.size} windows)`, rows));
}

await main();
