// One benchmark photo through every method: render -> JPEG -> engine, with the click models below.
// Click models (one sigma, per coordinate, in inches on the frame plane, converted to pixels at the window):
// - careful corner clicks on the window: 0.25 in (the brief's 1/4-1/2 in); on the paper's corners: 0.1 in;
// - rough clicks for snapping: up to 4% of the window's size, uniform in a disc;
// - the tape-measured side for 'known side': 1/32 in; the offset the person types: 1/8 in.
import jpeg from 'jpeg-js';
import { DEFAULT_FOCAL_35MM, focalPxFrom35mm, measureWithSheet, type Pt, type Quad, sizeFromKnownSide, sizeFromReference } from '@roofline/shared';
import { detectSheetSync } from '../../apps/web/src/features/measure/windows/cv/detect-sheet.ts';
import { mulberry32, renderScene } from '../../apps/web/src/features/measure/windows/cv/synth/render.ts';
import { snapQuadSync } from '../../apps/web/src/features/measure/windows/cv/snap-quad.ts';
import type { BenchPhoto } from './scenes.ts';

export const METHODS = ['paper4', 'knownSide', 'sheetNoSnap', 'sheetSnap', 'sheetSnapOffset', 'sheetSnapExactOffset'] as const;
export type Method = (typeof METHODS)[number];
export type MethodResult = { w: number; h: number; uw?: number; uh?: number; warnings?: string[] } | null;
export type PhotoResult = {
  windowId: number;
  photo: number;
  mp: number;
  distanceFt: number;
  angleDeg: number;
  truth: { w: number; h: number; offsetIn: number };
  detected: boolean;
  points: number;
  rmsPx: number | null;
  snapCornerErrPx: number[] | null;
  rivals: number[] | null;
  ms: { render: number; detect: number; snap: number };
  results: Record<Method, MethodResult>;
};

export function encodeDecode(p: { width: number; height: number; data: Uint8ClampedArray }, q: number) {
  const enc = jpeg.encode({ width: p.width, height: p.height, data: p.data }, q);
  const dec = jpeg.decode(enc.data, { useTArray: true, maxMemoryUsageInMB: 2048 });
  return { jpg: enc.data, img: { width: dec.width, height: dec.height, data: new Uint8ClampedArray(dec.data.buffer, dec.data.byteOffset, dec.data.byteLength) } };
}

export function evaluatePhoto(windowId: number, photoIdx: number, bp: BenchPhoto, truth: { w: number; h: number; offsetIn: number }, keepJpeg = false): PhotoResult & { jpg?: Uint8Array; windowQuad?: Quad; snapped?: Quad; rough?: Quad; sheetOutline?: Quad | null } {
  const rnd = mulberry32(bp.seed ^ 0x51ed270b);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());
  let t = Date.now();
  const ph = renderScene(bp.scene);
  const tRender = Date.now() - t;
  const { jpg, img } = encodeDecode(ph, bp.jpegQuality);
  const W = img.width;
  const H = img.height;
  // What the phone writes: the 35 mm focal length rounded to a whole mm.
  const focalPx = focalPxFrom35mm(Math.round(bp.scene.focal35mm) || DEFAULT_FOCAL_35MM, W, H);
  const pxPerIn = 1 / ph.inchesPerPx;
  const truthQ = ph.windowQuad;
  const jitter = (q: Quad, sIn: number): Quad => q.map(([x, y]) => [x + gauss() * sIn * pxPerIn, y + gauss() * sIn * pxPerIn]) as Quad;
  const clicked = jitter(truthQ, 0.25);
  const results = {} as Record<Method, MethodResult>;
  // Old: four clicks on a sheet of letter paper (its corners), window clicked, no plane offset.
  {
    const paperQ = jitter(ph.paperQuad!, 0.1);
    const pw = bp.scene.sheet!.paper === 'letter' ? 8.5 : 210 / 25.4;
    const phh = bp.scene.sheet!.paper === 'letter' ? 11 : 297 / 25.4;
    const s = sizeFromReference(clicked, paperQ, pw, phh);
    results.paper4 = s === null ? null : { w: s.widthIn, h: s.heightIn };
  }
  // Known side: width taped (1/32 in), height from the rectangle's aspect.
  {
    const s = sizeFromKnownSide(clicked, W, H, 'width', truth.w + gauss() / 32, focalPx);
    results.knownSide = s === null ? null : { w: s.widthIn, h: s.heightIn };
  }
  t = Date.now();
  const det = detectSheetSync(img);
  const tDetect = Date.now() - t;
  // Rough corners for snapping: up to 4% of the window's size off.
  const sidePx = (Math.hypot(truthQ[1][0] - truthQ[0][0], truthQ[1][1] - truthQ[0][1]) + Math.hypot(truthQ[3][0] - truthQ[0][0], truthQ[3][1] - truthQ[0][1])) / 2;
  const rough = truthQ.map(([x, y]) => {
    const r = 0.04 * sidePx * Math.sqrt(rnd());
    const a = 2 * Math.PI * rnd();
    return [x + r * Math.cos(a), y + r * Math.sin(a)] as Pt;
  }) as Quad;
  t = Date.now();
  const snap = snapQuadSync(img, rough);
  const tSnap = Date.now() - t;
  const enteredOffset = truth.offsetIn + gauss() / 8;
  const m = (quad: Quad, offset: number, sigma?: [number, number, number, number] | number): MethodResult => {
    if (det === null) return null;
    const r = measureWithSheet({ widthPx: W, heightPx: H, focalPx, imagePoints: det.imagePoints, sheetPointsIn: det.sheetPointsIn, windowQuad: quad, planeOffsetIn: offset, cornerSigmaPx: sigma, offsetSigmaIn: 0.125 });
    return r === null ? null : { w: r.widthIn, h: r.heightIn, uw: r.uncertaintyIn.width, uh: r.uncertaintyIn.height, warnings: r.warnings };
  };
  results.sheetNoSnap = m(clicked, 0, 0.25 * pxPerIn);
  results.sheetSnap = m(snap.quad, 0, snap.cornerSigmaPx);
  results.sheetSnapOffset = m(snap.quad, enteredOffset, snap.cornerSigmaPx);
  // Diagnostic: the offset known exactly (what the person's 1/8 in offset guess costs).
  results.sheetSnapExactOffset = m(snap.quad, truth.offsetIn, snap.cornerSigmaPx);
  // Camera geometry for the bins: distance to the window's centre and angle off square.
  const sc = bp.scene;
  const out = {
    windowId,
    photo: photoIdx,
    mp: bp.megapixels,
    distanceFt: sc.distanceIn / 12,
    angleDeg: (Math.acos(Math.cos((sc.yawDeg * Math.PI) / 180) * Math.cos((sc.pitchDeg * Math.PI) / 180)) * 180) / Math.PI,
    truth,
    detected: det !== null,
    points: det?.imagePoints.length ?? 0,
    rmsPx: det?.rmsErrorPx ?? null,
    snapCornerErrPx: snap.quad.map((p, k) => Math.hypot(p[0] - truthQ[k]![0], p[1] - truthQ[k]![1])),
    rivals: snap.rivals,
    ms: { render: tRender, detect: tDetect, snap: tSnap },
    results,
  };
  return keepJpeg ? { ...out, jpg, windowQuad: truthQ, snapped: snap.quad, rough, sheetOutline: det?.outline ?? null } : out;
}
