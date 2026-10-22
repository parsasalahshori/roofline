import { mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { OWLV2_INTERIOR_LABELS, OwlV2Detector, owlv2Present, pickWindowBox, type DetectedBox } from '../apps/api/src/providers/window-detector.ts';
import { chooseQuad, loadSam2, sam2Present, type SegmentOutput } from '../apps/api/src/providers/window-segmenter.ts';

/*
 * Does the real OWLv2 find a window in a photo taken inside a home, does SAM 2 cut it out, and how long does that take on this Mac? Runs the
 * very detector and segmenter the homeowner route (POST /requests/:id/detect-windows) uses on the photos given, each first cut down the
 * way the phone does (about 1024 px on the long side, JPEG quality 0.7), and prints the boxes OWLv2 keeps, the box the person would have
 * aimed at (the one holding the photo's middle), the quad SAM 2's mask gives (with its quality) and the time of each step. Not shipped.
 *
 *   npx tsx scripts/detect-windows-sample.ts [--model-dir DIR] [--out DIR] [--runs N] [--no-point] [--no-sam] photo.jpg [photo2.jpg ...]
 *
 * --model-dir  where the models are (default: WINDOW_MODEL_DIR, else ~/RooflineWork/models); nothing is downloaded
 * --out        also writes each photo as a PNG with its boxes (orange), the picked box (blue), SAM 2's mask (red) and the quad (green) drawn on it
 * --runs       how many times each photo is run after the first (default 2); the first run of all includes loading the models
 * --no-point   SAM 2 is prompted with the box only (default: the box and the photo's middle as a positive point)
 * --no-sam     OWLv2 only
 */

const args = process.argv.slice(2);
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
};
const take = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
};
const noPoint = flag('--no-point');
const noSam = flag('--no-sam');
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
const useSam = !noSam && sam2Present(modelDir);
if (!noSam && !useSam) console.log(`(SAM 2 is not in ${modelDir}: OWLv2 only)`);
if (outDir !== undefined) mkdirSync(outDir, { recursive: true });

const detector = new OwlV2Detector({ modelDir });
console.log(`queries: ${OWLV2_INTERIOR_LABELS.join(' | ')}`);
let t0 = performance.now();
await detector.warm();
console.log(`OWLv2 loaded in ${Math.round(performance.now() - t0)} ms`);
t0 = performance.now();
const sam = useSam ? await loadSam2(modelDir) : null;
if (sam !== null) console.log(`SAM 2.1 tiny loaded in ${Math.round(performance.now() - t0)} ms`);

const fmt = (b: DetectedBox) => `x ${b.x.toFixed(3)}  y ${b.y.toFixed(3)}  w ${b.w.toFixed(3)}  h ${b.h.toFixed(3)}  conf ${b.confidence.toFixed(3)}`;
const owl: number[] = [];
const seg: number[] = [];
const total: number[] = [];

for (const file of photos) {
  // What the phone sends: upright, about 1024 px on the long side, JPEG 0.7
  const sent = await sharp(readFileSync(file)).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  const meta = await sharp(sent).metadata();
  const { width: W = 0, height: H = 0 } = meta;
  console.log(`\n${path.basename(file)}: sent ${W} x ${H}, ${(sent.length / 1024).toFixed(0)} KB`);
  let boxes: DetectedBox[] = [];
  let picked: DetectedBox | null = null;
  let out: SegmentOutput | null = null;
  let chosen: ReturnType<typeof chooseQuad> = null;
  for (let i = 0; i <= runs; i++) {
    const a = performance.now();
    boxes = await detector.detectInterior(new Uint8Array(sent));
    const b = performance.now();
    picked = pickWindowBox(boxes);
    out = null;
    chosen = null;
    if (sam !== null && picked !== null) {
      out = await sam.run(new Uint8Array(sent), { box: picked, point: noPoint ? null : { x: 0.5, y: 0.5 } });
      chosen = chooseQuad(out, picked);
    }
    const c = performance.now();
    owl.push(b - a);
    seg.push(c - b);
    total.push(c - a);
    console.log(`  run ${i + 1}: OWLv2 ${Math.round(b - a)} ms, SAM 2 + quad ${Math.round(c - b)} ms, total ${Math.round(c - a)} ms`);
  }
  for (const b of boxes) console.log(`  box   ${fmt(b)}`);
  if (boxes.length === 0) console.log('  (no window box found)');
  if (picked !== null) console.log(`  picked ${fmt(picked)}`);
  else if (boxes.length > 0) console.log('  (no box holds the photo\'s middle)');
  if (chosen !== null) {
    const q = chosen.quad;
    console.log(`  quad  ${q.corners.map(([x, y]) => `(${x.toFixed(3)}, ${y.toFixed(3)})`).join(' ')}  quality ${q.quality}  fill ${q.fill}  residual ${q.residual}  mask #${chosen.maskIndex} score ${q.maskScore}`);
  } else if (picked !== null && sam !== null) console.log('  (SAM 2: no believable quad in the mask)');

  if (outDir !== undefined && W > 0) {
    const layers: sharp.OverlayOptions[] = [];
    if (out !== null && chosen !== null) {
      // The chosen mask in translucent red
      const rgba = Buffer.alloc(W * H * 4);
      const mask = out.masks[chosen.maskIndex]!;
      for (let i = 0; i < W * H; i++) if (mask[i] !== 0) rgba.set([255, 40, 40, 110], i * 4);
      layers.push({ input: rgba, raw: { width: W, height: H, channels: 4 } });
    }
    const shapes: string[] = boxes.map((b) => `<rect x="${b.x * W}" y="${b.y * H}" width="${b.w * W}" height="${b.h * H}" fill="none" stroke="#ff9500" stroke-width="2" stroke-dasharray="6 4"/>`);
    if (picked !== null) shapes.push(`<rect x="${picked.x * W}" y="${picked.y * H}" width="${picked.w * W}" height="${picked.h * H}" fill="none" stroke="#1e88ff" stroke-width="4"/>`);
    if (chosen !== null) {
      const pts = chosen.quad.corners.map(([x, y]) => `${x * W},${y * H}`).join(' ');
      shapes.push(`<polygon points="${pts}" fill="none" stroke="#1fbf4b" stroke-width="5"/>`);
      for (const [x, y] of chosen.quad.corners) shapes.push(`<circle cx="${x * W}" cy="${y * H}" r="9" fill="#1fbf4b" stroke="white" stroke-width="3"/>`);
    }
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${shapes.join('')}</svg>`) });
    const outFile = path.join(outDir, `${path.basename(file, path.extname(file))}-ai.png`);
    await sharp(sent).composite(layers).png().toFile(outFile);
    console.log(`  drawn: ${outFile}`);
  }
}

const mean = (v: number[]) => (v.length === 0 ? 0 : Math.round(v.reduce((a, b) => a + b, 0) / v.length));
const cpu = os.cpus()[0]?.model ?? 'this machine';
console.log(`\ntiming on ${cpu}: OWLv2 ${mean(owl)} ms, SAM 2 + quad ${mean(seg)} ms, both ${mean(total)} ms per photo (min ${Math.round(Math.min(...total))}, max ${Math.round(Math.max(...total))})`);
