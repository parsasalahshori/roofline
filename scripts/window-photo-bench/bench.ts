// The synthetic benchmark: `npx tsx scripts/window-photo-bench/bench.ts [--windows 60] [--seed 1] [--jobs 8] [--out dir]`.
// Renders `windows` windows x 3 photos (12 MP and 3 MP, 3-12 ft, 0-45 deg, blur, noise, JPEG q70-90, lens distortion,
// sheet curl and occlusion, frame 0-2 in proud of the glass), runs every method, and writes results.jsonl, results.md
// (the error tables) and a few example photos with the corners drawn. Reproducible: same seed, same numbers.
import { spawn } from 'node:child_process';
import jpeg from 'jpeg-js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { combineSheetMeasurements, type Quad } from '@roofline/shared';
import { encodeDecode, evaluatePhoto, METHODS, type PhotoResult } from './evaluate.ts';
import { median, quantile, type Row, table } from './report.ts';
import { benchWindows, refusalPhotos } from './scenes.ts';
import { detectSheetSync } from '../../apps/web/src/features/measure/windows/cv/detect-sheet.ts';
import { measureWithSheet, focalPxFrom35mm } from '@roofline/shared';
import { renderScene } from '../../apps/web/src/features/measure/windows/cv/synth/render.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string, dflt: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : dflt;
};
const windows = Number(arg('windows', '60'));
const seed = Number(arg('seed', '1'));
const jobs = Number(arg('jobs', String(Math.max(1, cpus().length - 1))));
const out = path.resolve(arg('out', path.join(here, 'out')));
mkdirSync(out, { recursive: true });

const NAMES: Record<string, string> = {
  paper4: 'old 4-click paper',
  knownSide: 'known side (width taped)',
  sheetNoSnap: 'sheet, clicked corners, no offset correction',
  sheetSnap: 'sheet + snapping, no offset correction',
  sheetSnapOffset: 'sheet + snapping + offset correction',
  sheetSnapExactOffset: '(diagnostic) same, offset known exactly',
  combined3: 'sheet + snapping + offset, 3 photos combined',
};

async function runWorkers(): Promise<PhotoResult[]> {
  const file = path.join(out, 'results.jsonl');
  if (existsSync(file)) rmSync(file);
  const started = Date.now();
  await Promise.all(
    Array.from({ length: jobs }, (_, w) =>
      new Promise<void>((resolve, reject) => {
        const p = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'chunk.ts'), String(windows), String(seed), String(w), String(jobs), file], { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}`))));
      }),
    ),
  );
  console.log(`rendered and measured ${windows * 3} photos in ${((Date.now() - started) / 1000).toFixed(0)} s on ${jobs} workers`);
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PhotoResult);
}

function rows(rs: PhotoResult[], filter: (r: PhotoResult) => boolean): Row[] {
  const sel = rs.filter(filter);
  const list: Row[] = METHODS.map((m) => {
    const ok = sel.filter((r) => r.results[m] !== null);
    return { method: NAMES[m]!, errW: ok.map((r) => r.results[m]!.w - r.truth.w), errH: ok.map((r) => r.results[m]!.h - r.truth.h), refused: sel.length - ok.length, total: sel.length };
  });
  // Combined: windows with all three photos in the selection and measured.
  const byWin = new Map<number, PhotoResult[]>();
  for (const r of sel) byWin.set(r.windowId, [...(byWin.get(r.windowId) ?? []), r]);
  const errW: number[] = [];
  const errH: number[] = [];
  let refused = 0;
  let total = 0;
  for (const group of byWin.values()) {
    if (group.length < 2) continue;
    total++;
    const ms = group.map((r) => r.results.sheetSnapOffset).filter((x) => x !== null).map((x) => ({ widthIn: x!.w, heightIn: x!.h }));
    const c = ms.length >= 2 ? combineSheetMeasurements(ms) : null;
    if (c === null) {
      refused++;
      continue;
    }
    errW.push(c.widthIn - group[0]!.truth.w);
    errH.push(c.heightIn - group[0]!.truth.h);
  }
  list.push({ method: `${NAMES.combined3} (windows with >= 2 photos in the bin)`, errW, errH, refused, total });
  return list;
}

function drawQuad(img: { width: number; height: number; data: Uint8ClampedArray }, q: Quad | null, rgb: [number, number, number], thick = 2) {
  if (q === null) return;
  for (let i = 0; i < 4; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % 4]!;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]));
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const y = a[1] + ((b[1] - a[1]) * k) / n;
      for (let dy = -thick; dy <= thick; dy++) {
        for (let dx = -thick; dx <= thick; dx++) {
          const px = Math.round(x + dx);
          const py = Math.round(y + dy);
          if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
          const j = (py * img.width + px) * 4;
          img.data[j] = rgb[0];
          img.data[j + 1] = rgb[1];
          img.data[j + 2] = rgb[2];
        }
      }
    }
  }
}

async function main() {
  const rs = await runWorkers();
  const near = (r: PhotoResult) => r.distanceFt <= 10 && r.angleDeg <= 35;
  let md = `# Window photo measuring benchmark\n\nSeed ${seed}, ${windows} windows x 3 photos = ${rs.length} photos. Errors are measured minus true, absolute, inches.\n\n`;
  md += table('All photos (3-12 ft, 0-45 deg, 12 MP and 3 MP)', rows(rs, () => true));
  md += '\n' + table('Target zone: <= 10 ft and <= 35 deg', rows(rs, near));
  md += '\n' + table('Target zone, 12 MP only', rows(rs, (r) => near(r) && r.mp === 12));
  md += '\n' + table('Target zone, 3 MP only', rows(rs, (r) => near(r) && r.mp === 3));
  md += '\n' + table('Far or steep: > 10 ft or > 35 deg', rows(rs, (r) => !near(r)));

  // Uncertainty calibration for sheet + snapping + offset.
  const cal = rs.filter((r) => r.results.sheetSnapOffset !== null);
  const within = (k: number) =>
    cal.filter((r) => Math.abs(r.results.sheetSnapOffset!.w - r.truth.w) <= k * r.results.sheetSnapOffset!.uw! && Math.abs(r.results.sheetSnapOffset!.h - r.truth.h) <= k * r.results.sheetSnapOffset!.uh!).length / Math.max(1, cal.length);
  md += `\n### Reported uncertainty (sheet + snapping + offset)\n\nBoth width and height inside 1 sigma: ${(100 * within(1)).toFixed(0)}% (ideal about 47% for two independent normals), inside 2 sigma: ${(100 * within(2)).toFixed(0)}% (ideal about 91%). Median reported sigma: width ${median(cal.map((r) => r.results.sheetSnapOffset!.uw!)).toFixed(3)} in, height ${median(cal.map((r) => r.results.sheetSnapOffset!.uh!)).toFixed(3)} in.\n`;

  // Engine diagnostics.
  const det = rs.filter((r) => r.detected);
  const snapErr = rs.flatMap((r) => r.snapCornerErrPx ?? []);
  md += `\n### Engine diagnostics\n\n- Sheet found in ${det.length}/${rs.length} photos; median ${median(det.map((r) => r.points))} points; sheet RMS median ${median(det.map((r) => r.rmsPx!)).toFixed(3)} px, p95 ${quantile(det.map((r) => r.rmsPx!), 0.95).toFixed(3)} px.\n`;
  md += `- Snapped corner error vs truth: median ${median(snapErr).toFixed(2)} px, p90 ${quantile(snapErr, 0.9).toFixed(2)} px, p95 ${quantile(snapErr, 0.95).toFixed(2)} px (rough clicks up to 4% of the window off). Corners off by > 3 px (wrong edge picked): ${snapErr.filter((e) => e > 3).length}/${snapErr.length}.\n`;
  for (const mp of [12, 3]) {
    const s = rs.filter((r) => r.mp === mp);
    md += `- ${mp} MP timings on this Mac (one core, Node): detect median ${median(s.map((r) => r.ms.detect))} ms (p95 ${quantile(s.map((r) => r.ms.detect), 0.95)}), snap median ${median(s.map((r) => r.ms.snap))} ms.\n`;
  }

  // Refusals: photos the engine should not measure.
  md += '\n### Refusals (photos that must not give a confident wrong answer)\n\n| case | photo | sheet found | measured | warnings | width error | height error |\n|---|---|---|---|---|---|---|\n';
  for (const rp of refusalPhotos(seed + 100)) {
    const ph = renderScene(rp.photo.scene);
    const { img } = encodeDecode(ph, rp.photo.jpegQuality);
    const d = detectSheetSync(img);
    const fpx = focalPxFrom35mm(Math.round(rp.photo.scene.focal35mm), img.width, img.height);
    const m = d === null ? null : measureWithSheet({ widthPx: img.width, heightPx: img.height, focalPx: fpx, imagePoints: d.imagePoints, sheetPointsIn: d.sheetPointsIn, windowQuad: ph.windowQuad, planeOffsetIn: rp.offsetIn });
    md += `| ${rp.kind} | ${rp.photo.seed} | ${d === null ? 'no (refused)' : `yes, ${d.imagePoints.length} pts, RMS ${d.rmsErrorPx.toFixed(2)} px`} | ${m === null ? '-' : `${m.widthIn.toFixed(2)} x ${m.heightIn.toFixed(2)} (true ${rp.widthIn} x ${rp.heightIn})`} | ${m === null ? '-' : m.warnings.join(' / ') || 'none'} | ${m === null ? '-' : (m.widthIn - rp.widthIn).toFixed(3)} | ${m === null ? '-' : (m.heightIn - rp.heightIn).toFixed(3)} |\n`;
  }

  writeFileSync(path.join(out, 'results.md'), md);
  console.log(md);

  // Example photos: truth green, rough yellow, snapped red, the sheet's outline blue.
  const wins = benchWindows(windows, seed);
  for (const [wi, k] of [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 0],
  ] as const) {
    const w = wins[wi];
    if (w === undefined) continue;
    const r = evaluatePhoto(w.id, k, w.photos[k]!, { w: w.widthIn, h: w.heightIn, offsetIn: w.offsetIn }, true);
    const dec = jpeg.decode(r.jpg!, { useTArray: true, maxMemoryUsageInMB: 2048 });
    const img = { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength) };
    drawQuad(img, r.sheetOutline ?? null, [40, 90, 255]);
    drawQuad(img, r.rough!, [255, 210, 0]);
    drawQuad(img, r.windowQuad!, [0, 200, 60], 3);
    drawQuad(img, r.snapped!, [255, 30, 30], 1);
    writeFileSync(path.join(out, `example-${wi}-${k}.jpg`), encodeDecode(img, 85).jpg);
    writeFileSync(path.join(out, `example-${wi}-${k}-raw.jpg`), r.jpg!);
  }
}

await main();
