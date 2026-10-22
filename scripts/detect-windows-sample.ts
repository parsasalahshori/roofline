import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { OWLV2_INTERIOR_LABELS, OwlV2Detector, owlv2Present, type DetectedBox } from '../apps/api/src/providers/window-detector.ts';

/*
 * Does the real OWLv2 find a window in a photo taken inside a home, and how long does it take on this Mac? Runs the very
 * detector the homeowner route (POST /requests/:id/detect-windows) uses on the photos given, each first cut down the way the
 * phone does (about 1024 px on the long side, JPEG quality 0.7), and prints the boxes it keeps and the time. Not shipped.
 *
 *   npx tsx scripts/detect-windows-sample.ts [--model-dir DIR] [--out DIR] [--runs N] photo.jpg [photo2.jpg ...]
 *
 * --model-dir  where Xenova/owlv2-base-patch16-ensemble is (default: WINDOW_MODEL_DIR, else ~/RooflineWork/models); nothing is downloaded
 * --out        also writes each photo with its boxes drawn on it (green: best, orange: the others) to that folder
 * --runs       how many times each photo is run after the first (default 2); the first run of all includes loading the model
 */

const args = process.argv.slice(2);
const take = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const modelDir = take('--model-dir') ?? process.env.WINDOW_MODEL_DIR ?? path.join(os.homedir(), 'RooflineWork', 'models');
const outDir = take('--out');
const runs = Number(take('--runs') ?? '2');
const photos = args;
if (photos.length === 0) {
  console.error('Give at least one photo: npx tsx scripts/detect-windows-sample.ts [--out DIR] photo.jpg ...');
  process.exit(2);
}
if (!owlv2Present(modelDir)) {
  console.error(`The OWLv2 model is not in ${modelDir} (expected Xenova/owlv2-base-patch16-ensemble/onnx/model_quantized.onnx). Nothing is downloaded.`);
  process.exit(2);
}
if (outDir !== undefined) mkdirSync(outDir, { recursive: true });

const detector = new OwlV2Detector({ modelDir });
console.log(`queries: ${OWLV2_INTERIOR_LABELS.join(' | ')}`);
const t0 = performance.now();
await detector.warm();
console.log(`model loaded in ${Math.round(performance.now() - t0)} ms`);

const fmt = (b: DetectedBox) => `x ${b.x.toFixed(3)}  y ${b.y.toFixed(3)}  w ${b.w.toFixed(3)}  h ${b.h.toFixed(3)}  conf ${b.confidence.toFixed(3)}`;
const times: number[] = [];

for (const file of photos) {
  // What the phone sends: upright, about 1024 px on the long side, JPEG 0.7
  const sent = await sharp(readFileSync(file)).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  const meta = await sharp(sent).metadata();
  console.log(`\n${path.basename(file)}: sent ${meta.width} x ${meta.height}, ${(sent.length / 1024).toFixed(0)} KB`);
  let boxes: DetectedBox[] = [];
  for (let i = 0; i <= runs; i++) {
    const start = performance.now();
    boxes = await detector.detectInterior(new Uint8Array(sent));
    const ms = Math.round(performance.now() - start);
    times.push(ms);
    console.log(`  run ${i + 1}: ${ms} ms, ${boxes.length} window box(es)`);
  }
  for (const b of boxes) console.log(`  ${fmt(b)}`);
  if (boxes.length === 0) console.log('  (no window found)');
  if (outDir !== undefined && meta.width !== undefined && meta.height !== undefined) {
    const { width: W, height: H } = meta;
    const rects = boxes
      .map((b, i) => `<rect x="${b.x * W}" y="${b.y * H}" width="${b.w * W}" height="${b.h * H}" fill="none" stroke="${i === 0 ? '#1fbf4b' : '#ff9500'}" stroke-width="${i === 0 ? 6 : 3}"/>`)
      .join('');
    const out = path.join(outDir, `${path.basename(file, path.extname(file))}-boxes.jpg`);
    await sharp(sent)
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${rects}</svg>`) }])
      .jpeg({ quality: 85 })
      .toFile(out);
    console.log(`  drawn: ${out}`);
  }
}

const warm = times.filter((_, i) => i % (runs + 1) !== 0);
const first = times.filter((_, i) => i % (runs + 1) === 0);
const mean = (v: number[]) => (v.length === 0 ? 0 : Math.round(v.reduce((a, b) => a + b, 0) / v.length));
console.log(`\ntiming on ${os.cpus()[0]?.model ?? 'this machine'}: first run of each photo ${mean(first)} ms, later runs ${mean(warm)} ms (min ${Math.min(...times)}, max ${Math.max(...times)})`);
