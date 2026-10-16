import {
  applyHomography,
  CARD_CHECK_UNCERTAINTY_IN,
  CARD_DEFAULT_OFFSET_IN,
  CARD_OFFSET_SIGMA_IN,
  CARD_RECT_SIGMA_MM,
  CARD_SIGMA_SCALE,
  defaultTapSigmaPx,
  focalPxFrom35mm,
  homography,
  ID1_CARD_MM,
  ID1_TAP_RECT_MM,
  INCHES_PER_METRE,
  SHEET_FOCAL_SIGMA,
  sizeFromCard,
  type Pt,
  type Quad,
} from '@roofline/shared';

/*
 * Monte-Carlo accuracy study of the card method (packages/shared/src/window-photo-card.ts, docs/windows/card-method.md).
 * It prints the markdown tables and the assumptions pasted into that doc. SYNTHETIC photos only: a pinhole camera looking
 * at a flat window, no lens distortion, taps that are Gaussian. Real photos will do worse until the field test.
 *
 *   npx tsx scripts/window-card-accuracy.ts [--trials N] [--seed N]    the tables (default 4000 trials per row, seed 20261016)
 *   npx tsx scripts/window-card-accuracy.ts --fit [--trials N]         the calibration: how many sigmas hold 68% of the errors
 *
 * Each trial draws the truth the way the uncertainty assumes it: every tapped coordinate (card and window) gets
 * Gaussian noise of tapSigma px; the frame's offset in front of the glass is 1 +- 0.5 in (the sizing is told 1 in); the
 * focal length is 26 mm-equivalent +- 3% (the sizing is told 26); the tapped card rectangle is the ID-1 card inset by its
 * rounded corners +- 0.5 mm per side. The card lies landscape or portrait at random, turned up to 10 degrees, tapped from a
 * random corner in a random direction. Deterministic: a seeded generator, nothing else random.
 */

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const TRIALS = Number(opt('--trials') ?? 4000);
const SEED = Number(opt('--seed') ?? 20261016);
/** The seed the calibration constant was fitted on (the tables use another, so they are a held-out check of it). */
const FIT_SEED = 1;
const M = INCHES_PER_METRE;
const IN_PER_MM = 1 / 25.4;
const FOCAL35_ASSUMED = 26;
const OFFSET_SIGMA = CARD_OFFSET_SIGMA_IN;
const FOCAL_SIGMA = SHEET_FOCAL_SIGMA;

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic photos (camera frame as in the tests: the glass is z = 0, x right, y down, inches; the camera is at z < 0)

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussianFrom = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

function camera(o: { distanceIn: number; yawDeg: number; pitchDeg: number; focalPx: number; w: number; h: number; target: V3 }) {
  const yaw = (o.yawDeg * Math.PI) / 180;
  const pitch = (o.pitchDeg * Math.PI) / 180;
  const C: V3 = [o.target[0] + o.distanceIn * Math.sin(yaw) * Math.cos(pitch), o.target[1] - o.distanceIn * Math.sin(pitch), -o.distanceIn * Math.cos(yaw) * Math.cos(pitch)];
  const f = unit(sub(o.target, C));
  const x = unit(cross(f, [0, -1, 0]));
  const y = cross(f, x);
  return (P: V3): Pt => {
    const d = sub(P, C);
    const cam = [x, y, f].map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]) as V3;
    return [o.focalPx * (cam[0] / cam[2]) + o.w / 2, o.focalPx * (cam[1] / cam[2]) + o.h / 2];
  };
}

type Shot = { winW: number; winH: number; yawDeg: number; metres: number };
type Scene = { widthPx: number; heightPx: number; distanceIn: number };

/** The photo's size and the camera's distance: `metres` from the glass, or farther back when the window would not fit with a 5% margin. */
function scene(s: Shot): Scene {
  const portrait = s.winH >= s.winW;
  const widthPx = portrait ? 3024 : 4032;
  const heightPx = portrait ? 4032 : 3024;
  const focalPx = focalPxFrom35mm(FOCAL35_ASSUMED, widthPx, heightPx);
  let distanceIn = s.metres * M;
  for (let i = 0; i < 500; i++) {
    const project = camera({ distanceIn, yawDeg: s.yawDeg, pitchDeg: 0, focalPx, w: widthPx, h: heightPx, target: [s.winW / 2, s.winH / 2, 0] });
    const q = ([[0, 0], [s.winW, 0], [s.winW, s.winH], [0, s.winH]] as Pt[]).map(([x, y]) => project([x, y, -CARD_DEFAULT_OFFSET_IN - 2 * OFFSET_SIGMA]));
    if (q.every((p) => p[0] > 0.05 * widthPx && p[0] < 0.95 * widthPx && p[1] > 0.05 * heightPx && p[1] < 0.95 * heightPx)) break;
    distanceIn *= 1.02;
  }
  return { widthPx, heightPx, distanceIn };
}

type Truth = {
  offsetIn: number;
  focal35: number;
  rectScale: [number, number];
  cardPortrait: boolean;
  cardRotDeg: number;
  /** Not drawn in the trials: set by the "what the model does not cover" rows. */
  cardTiltDeg?: number;
  distortionEdge?: number;
};

/**
 * The four taps on the card and on the window frame, noise-free, for one draw of the truth. Optional: the card tilted off the
 * glass about its long axis (its top edge toward the camera), and radial lens distortion (the picture bent by this share at
 * the photo's long-side edge: positive moves points outward).
 */
function taps(s: Shot, sc: Scene, t: Truth): { card: Quad; win: Quad; focalPx: number } {
  const focalPx = focalPxFrom35mm(t.focal35, sc.widthPx, sc.heightPx);
  const project = camera({ distanceIn: sc.distanceIn, yawDeg: s.yawDeg, pitchDeg: 0, focalPx, w: sc.widthPx, h: sc.heightPx, target: [s.winW / 2, s.winH / 2, 0] });
  const rEdge = Math.max(sc.widthPx, sc.heightPx) / 2 / focalPx;
  const k = (t.distortionEdge ?? 0) / (rEdge * rEdge);
  const bend = (p: Pt): Pt => {
    const x = (p[0] - sc.widthPx / 2) / focalPx;
    const y = (p[1] - sc.heightPx / 2) / focalPx;
    const m = 1 + k * (x * x + y * y);
    return [sc.widthPx / 2 + x * m * focalPx, sc.heightPx / 2 + y * m * focalPx];
  };
  const win = ([[0, 0], [s.winW, 0], [s.winW, s.winH], [0, s.winH]] as Pt[]).map(([x, y]) => bend(project([x, y, -t.offsetIn]))) as Quad;
  const rot = (t.cardRotDeg + (t.cardPortrait ? 90 : 0)) * (Math.PI / 180);
  const tilt = ((t.cardTiltDeg ?? 0) * Math.PI) / 180;
  const hw = (ID1_TAP_RECT_MM.widthMm * IN_PER_MM * t.rectScale[0]) / 2;
  const hh = (ID1_TAP_RECT_MM.heightMm * IN_PER_MM * t.rectScale[1]) / 2;
  const local: Pt[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const card = local.map(([u, v]) => {
    const vy = v * Math.cos(tilt);
    return bend(project([s.winW / 2 + u * Math.cos(rot) - vy * Math.sin(rot), s.winH / 2 + u * Math.sin(rot) + vy * Math.cos(rot), -v * Math.sin(tilt)]));
  }) as Quad;
  return { card, win, focalPx };
}

type Trial = { errW: number; errH: number; uW: number; uH: number; quality: 'good' | 'check' };

/** The textbook way, for comparison: the homography of the four card taps (oracle order, landscape card) applied to the window's corners. */
function exactHomographySize(card: Quad, win: Quad): { w: number; h: number } | null {
  const rect: Quad = [[0, 0], [ID1_TAP_RECT_MM.widthMm * IN_PER_MM, 0], [ID1_TAP_RECT_MM.widthMm * IN_PER_MM, ID1_TAP_RECT_MM.heightMm * IN_PER_MM], [0, ID1_TAP_RECT_MM.heightMm * IN_PER_MM]];
  const H = homography(card, rect);
  if (H === null) return null;
  const q = win.map((p) => applyHomography(H, p));
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  return { w: (d(q[0]!, q[1]!) + d(q[3]!, q[2]!)) / 2, h: (d(q[0]!, q[3]!) + d(q[1]!, q[2]!)) / 2 };
}

function runTrials(s: Shot, n: number, seed: number, tapSigmaPx?: number, exactHomography = false): { trials: Trial[]; ratio: number; metres: number } {
  const rnd = mulberry32(seed);
  const g = gaussianFrom(rnd);
  const sc = scene(s);
  const sigma = tapSigmaPx ?? defaultTapSigmaPx(sc.widthPx, sc.heightPx);
  const trials: Trial[] = [];
  let ratio = 0;
  for (let i = 0; i < n; i++) {
    const truth: Truth = {
      offsetIn: CARD_DEFAULT_OFFSET_IN + OFFSET_SIGMA * g(),
      focal35: FOCAL35_ASSUMED * (1 + FOCAL_SIGMA * g()),
      rectScale: [1 + (CARD_RECT_SIGMA_MM * g()) / ID1_TAP_RECT_MM.widthMm, 1 + (CARD_RECT_SIGMA_MM * g()) / ID1_TAP_RECT_MM.heightMm],
      cardPortrait: rnd() < 0.5,
      cardRotDeg: (rnd() - 0.5) * 20,
    };
    const t = taps(s, sc, exactHomography ? { ...truth, cardPortrait: false, cardRotDeg: 0 } : truth);
    const noisy = (q: Quad): Quad => q.map((p) => [p[0] + sigma * g(), p[1] + sigma * g()] as Pt) as Quad;
    const start = Math.floor(rnd() * 4);
    const reverse = rnd() < 0.5;
    const c = noisy(t.card);
    const win = noisy(t.win);
    if (exactHomography) {
      const r = exactHomographySize(c, win);
      trials.push({ errW: r === null ? Number.POSITIVE_INFINITY : r.w - s.winW, errH: r === null ? Number.POSITIVE_INFINITY : r.h - s.winH, uW: Number.NaN, uH: Number.NaN, quality: 'good' });
      continue;
    }
    const ordered: Pt[] = reverse ? [c[0], c[3], c[2], c[1]] : [c[0], c[1], c[2], c[3]];
    const r = sizeFromCard({
      widthPx: sc.widthPx,
      heightPx: sc.heightPx,
      focalPx: focalPxFrom35mm(FOCAL35_ASSUMED, sc.widthPx, sc.heightPx),
      cardCorners: [0, 1, 2, 3].map((k) => ordered[(k + start) % 4]!) as Quad,
      windowCorners: win,
      tapSigmaPx: sigma,
    });
    if (r === null) throw new Error(`the study's own photo could not be sized: ${JSON.stringify(s)} trial ${i}`);
    ratio = r.sizeRatio;
    trials.push({ errW: r.widthIn - s.winW, errH: r.heightIn - s.winH, uW: r.uncertaintyIn.width, uH: r.uncertaintyIn.height, quality: r.quality });
  }
  return { trials, ratio, metres: sc.distanceIn / M };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics and printing

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
const f2 = (v: number) => v.toFixed(2);
const pct = (v: number) => `${Math.round(100 * v)}%`;

function summary(trials: Trial[]) {
  const worst = trials.map((t) => Math.max(Math.abs(t.errW), Math.abs(t.errH)));
  return {
    claimed: quantile(trials.map((t) => Math.max(t.uW, t.uH)), 0.5),
    median: quantile(worst, 0.5),
    p95: quantile(worst, 0.95),
    check: trials.filter((t) => t.quality === 'check').length / trials.length,
  };
}

/** Pooled over both dimensions of every trial: how many errors fall inside k sigma of the ± the sizing claimed. */
function coverage(all: Trial[], k: number, scale = 1): number {
  let inside = 0;
  for (const t of all) inside += (Math.abs(t.errW) <= k * scale * t.uW ? 1 : 0) + (Math.abs(t.errH) <= k * scale * t.uH ? 1 : 0);
  return inside / (2 * all.length);
}

const SIZES: [number, number][] = [[24, 36], [36, 48], [36, 60], [48, 72], [60, 72], [72, 80]];
const SMALL: [number, number][] = [[12, 18], [18, 24]];
const SHOTS: { label: string; yawDeg: number; metres: number }[] = [
  { label: 'typical (15°, 1.5 m)', yawDeg: 15, metres: 1.5 },
  { label: 'square on (0°, 1.5 m)', yawDeg: 0, metres: 1.5 },
  { label: 'angled (40°, 1.5 m)', yawDeg: 40, metres: 1.5 },
  { label: 'close (15°, 1.0 m)', yawDeg: 15, metres: 1 },
  { label: 'far (15°, 2.5 m)', yawDeg: 15, metres: 2.5 },
];
/** A seed for one row or cell: the study's seed mixed with what the cell is, so no two cells share their draws. */
const cellSeed = (seed: number, ...parts: number[]): number =>
  parts.reduce((h, p) => {
    const x = Math.imul(h ^ ((p + 0x9e3779b9) | 0), 0x85ebca6b);
    return (x ^ (x >>> 13)) >>> 0;
  }, seed >>> 0);
const sizeLabel = ([w, h]: [number, number]) => `${w} x ${h}`;

/** The sizing of a noise-free photo of a window h tall (aspect wide:tall), for the "reach" scan and the breakdown. */
function noiseFree(h: number, aspect: number, shot: { yawDeg: number; metres: number }, extra: { tapSigmaPx?: number; focalSigmaFrac?: number } = {}) {
  const s: Shot = { winW: h * aspect, winH: h, yawDeg: shot.yawDeg, metres: shot.metres };
  const sc = scene(s);
  const t = taps(s, sc, { offsetIn: CARD_DEFAULT_OFFSET_IN, focal35: FOCAL35_ASSUMED, rectScale: [1, 1], cardPortrait: false, cardRotDeg: 0 });
  const r = sizeFromCard({ widthPx: sc.widthPx, heightPx: sc.heightPx, focalPx: t.focalPx, cardCorners: t.card, windowCorners: t.win, ...extra });
  if (r === null) throw new Error('the noise-free photo could not be sized');
  return Math.max(r.uncertaintyIn.width, r.uncertaintyIn.height);
}

/**
 * How far the claimed ± stays at or under CARD_CHECK_UNCERTAINTY_IN as the window grows (windows 2:3 wide:tall, from 6 in tall,
 * noise-free taps): the tallest window of the unbroken run from the smallest one (null when none is under), and the lowest ± found.
 */
function reach(aspect: number, shot: { yawDeg: number; metres: number }): { upToIn: number | null; lowest: { h: number; u: number } } {
  let upTo: number | null = null;
  let lowest = { h: 0, u: Number.POSITIVE_INFINITY };
  for (let h = 6; h <= 120; h += 0.5) {
    const u = noiseFree(h, aspect, shot);
    if (u < lowest.u) lowest = { h, u };
    if (u <= CARD_CHECK_UNCERTAINTY_IN) upTo = h;
    else if (upTo !== null) break;
  }
  return { upToIn: upTo, lowest };
}

if (args.includes('--fit')) {
  // Pool every cell of the tables (default tap noise), find the multiple of the unscaled ± that holds 68.27% of the errors.
  const z: number[] = [];
  const all: Trial[] = [];
  SHOTS.forEach((shot, si) => {
    for (const [w, h] of [...SMALL, ...SIZES]) {
      const { trials } = runTrials({ winW: w, winH: h, yawDeg: shot.yawDeg, metres: shot.metres }, TRIALS, cellSeed(FIT_SEED, w, h, si));
      all.push(...trials);
      for (const t of trials) z.push(Math.abs(t.errW) / (t.uW / CARD_SIGMA_SCALE), Math.abs(t.errH) / (t.uH / CARD_SIGMA_SCALE));
    }
  });
  const need = quantile(z, 0.6827);
  console.log(`Fit on seed ${FIT_SEED}, ${TRIALS} trials x ${SHOTS.length * (SIZES.length + SMALL.length)} cells, CARD_SIGMA_SCALE now ${CARD_SIGMA_SCALE}`);
  console.log(`68.27% of the errors fall inside ${need.toFixed(3)} x the unscaled propagated sigma (1 would be a perfect Gaussian)`);
  for (const scale of [1, 1.05, 1.1, 1.15, 1.2]) console.log(`scale ${scale.toFixed(2)}: inside 1 sigma ${pct(coverage(all, 1, scale / CARD_SIGMA_SCALE))}, inside 2 sigma ${pct(coverage(all, 2, scale / CARD_SIGMA_SCALE))}`);
} else {
  const everything: Trial[] = [];
  const perCell: number[] = [];
  const header = ['Window (in)', 'Camera (m)', 'Size ratio', 'Claimed ± (in), median', 'Real error (in), median', 'Real error (in), 95th pct', "Flagged 'check'"];
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const line = (n: number) => row(Array.from({ length: n }, () => '---'));

  console.log(`### Typical shot: ${SHOTS[0]!.label}, ${TRIALS} trials per row`);
  console.log('');
  console.log(row(header));
  console.log(line(header.length));
  for (const size of [...SMALL, ...SIZES]) {
    const { trials, ratio, metres } = runTrials({ winW: size[0], winH: size[1], yawDeg: SHOTS[0]!.yawDeg, metres: SHOTS[0]!.metres }, TRIALS, cellSeed(SEED, size[0], size[1], 0));
    const s = summary(trials);
    everything.push(...trials);
    perCell.push(coverage(trials, 1));
    console.log(row([sizeLabel(size), f2(metres), ratio.toFixed(1), f2(s.claimed), f2(s.median), f2(s.p95), pct(s.check)]));
  }

  console.log('');
  console.log(`### Other shots, ${TRIALS} trials per cell`);
  console.log('');
  console.log('Each cell: claimed ± / real error median / real error 95th pct (inches), then the share flagged check. Camera distance (m) in brackets.');
  console.log('');
  const others = SHOTS.slice(1);
  console.log(row(['Window (in)', ...others.map((o) => o.label)]));
  console.log(line(others.length + 1));
  for (const size of SIZES) {
    const cells = others.map((shot, k) => {
      const { trials, metres } = runTrials({ winW: size[0], winH: size[1], yawDeg: shot.yawDeg, metres: shot.metres }, TRIALS, cellSeed(SEED, size[0], size[1], k + 1));
      const s = summary(trials);
      everything.push(...trials);
      perCell.push(coverage(trials, 1));
      return `${f2(s.claimed)} / ${f2(s.median)} / ${f2(s.p95)}, ${pct(s.check)} (${f2(metres)})`;
    });
    console.log(row([sizeLabel(size), ...cells]));
  }

  console.log('');
  console.log(`### If the taps are sloppier than assumed (typical shot, ${TRIALS} trials per cell)`);
  console.log('');
  console.log(row(['Tap noise per coordinate', '24 x 36: claimed ± / real median', '48 x 72: claimed ± / real median']));
  console.log(line(3));
  const sigmas = [1, defaultTapSigmaPx(3024, 4032), 4, 8];
  sigmas.forEach((sg, k) => {
    const cells = ([[24, 36], [48, 72]] as [number, number][]).map(([w, h]) => {
      const { trials } = runTrials({ winW: w, winH: h, yawDeg: SHOTS[0]!.yawDeg, metres: SHOTS[0]!.metres }, TRIALS, cellSeed(SEED, w, h, 9, k), sg);
      const s = summary(trials);
      return `${f2(s.claimed)} / ${f2(s.median)}`;
    });
    console.log(row([`${sg.toFixed(sg === defaultTapSigmaPx(3024, 4032) ? 1 : 0)} px`, ...cells]));
  });

  console.log('');
  console.log(`### Why the window's corners give the plane's tilt (typical shot, ${TRIALS} trials per row)`);
  console.log('');
  console.log('The textbook way, an exact homography from the four card taps (given the right card order, no offset correction), against this method on the same kind of photos. Real error, inches, larger of width and height.');
  console.log('');
  console.log(row(['Window (in)', 'Homography from the card alone: median / 95th pct', 'This method: median / 95th pct']));
  console.log(line(3));
  for (const size of SIZES) {
    const shot: Shot = { winW: size[0], winH: size[1], yawDeg: SHOTS[0]!.yawDeg, metres: SHOTS[0]!.metres };
    const a = summary(runTrials(shot, TRIALS, cellSeed(SEED, size[0], size[1], 7), undefined, true).trials);
    const b = summary(runTrials(shot, TRIALS, cellSeed(SEED, size[0], size[1], 7)).trials);
    console.log(row([sizeLabel(size), `${f2(a.median)} / ${f2(a.p95)}`, `${f2(b.median)} / ${f2(b.p95)}`]));
  }

  console.log('');
  console.log('### Coverage of the claimed ± (the typical-shot and other-shots tables, both dimensions pooled)');
  console.log('');
  console.log(`- Inside 1 sigma: ${pct(coverage(everything, 1))} (68% would be exact); the lowest row has ${pct(Math.min(...perCell))}, the highest ${pct(Math.max(...perCell))}.`);
  console.log(`- Inside 2 sigma: ${pct(coverage(everything, 2))} (95% would be exact).`);
  console.log(`- Calibration constant CARD_SIGMA_SCALE = ${CARD_SIGMA_SCALE}, fitted on seed ${FIT_SEED} (npx tsx scripts/window-card-accuracy.ts --fit); these tables use seed ${SEED}.`);

  console.log('');
  console.log('### How far the claimed ± stays under 3/8 in (windows 2:3 wide:tall, noise-free taps, same assumptions)');
  console.log('');
  for (const shot of SHOTS) {
    const r = reach(2 / 3, shot);
    const ratio = (h: number) => (h / (85.6 * IN_PER_MM)).toFixed(1);
    console.log(
      r.upToIn === null
        ? `- ${shot.label}: never under 3/8 in; the lowest is ${f2(r.lowest.u)} in, at a window of about ${Math.round((r.lowest.h * 2) / 3)} x ${Math.round(r.lowest.h)} in.`
        : `- ${shot.label}: up to a window of about ${Math.round((r.upToIn * 2) / 3)} x ${Math.round(r.upToIn)} in (longest side ${Math.round(r.upToIn)} in, size ratio ${ratio(r.upToIn)}); above that the median claimed ± is over 3/8 in.`,
    );
  }

  console.log('');
  console.log('### Where the claimed ± comes from (typical shot, noise-free taps; share of the variance)');
  console.log('');
  console.log(row(['Window (in)', 'Tapped corners (card and window)', 'Focal length (3%)', 'Frame offset and card size']));
  console.log(line(4));
  for (const h of [36, 72]) {
    const shot = SHOTS[0]!;
    const total = noiseFree(h, 2 / 3, shot) ** 2;
    const noTaps = noiseFree(h, 2 / 3, shot, { tapSigmaPx: 0 }) ** 2;
    const noTapsNoFocal = noiseFree(h, 2 / 3, shot, { tapSigmaPx: 0, focalSigmaFrac: 0 }) ** 2;
    console.log(row([sizeLabel([Math.round((h * 2) / 3), h]), pct(1 - noTaps / total), pct((noTaps - noTapsNoFocal) / total), pct(noTapsNoFocal / total)]));
  }

  console.log('');
  console.log('### What the model does not cover (48 x 72 in window, typical shot, noise-free taps; the sizing is told the usual: frame 1 in, 26 mm, no distortion)');
  console.log('');
  console.log(row(['What is different in the photo', 'Width error (in)', 'Height error (in)']));
  console.log(line(3));
  {
    const shot: Shot = { winW: 48, winH: 72, yawDeg: SHOTS[0]!.yawDeg, metres: SHOTS[0]!.metres };
    const sc = scene(shot);
    const usual: Truth = { offsetIn: CARD_DEFAULT_OFFSET_IN, focal35: FOCAL35_ASSUMED, rectScale: [1, 1], cardPortrait: false, cardRotDeg: 0 };
    const signed = (v: number) => (Math.abs(v) < 0.005 ? '0.00' : `${v > 0 ? '+' : '-'}${Math.abs(v).toFixed(2)}`);
    const inch = ID1_TAP_RECT_MM;
    const rows: [string, Partial<Truth>][] = [
      ['Nothing (the photo is as assumed)', {}],
      ['Card tilted 10° off the glass', { cardTiltDeg: 10 }],
      ['Card tilted 30° off the glass', { cardTiltDeg: 30 }],
      ['Lens bends the picture 1% at its edge', { distortionEdge: 0.01 }],
      ['Lens bends the picture 2% at its edge', { distortionEdge: 0.02 }],
      ['Frame 2 in in front of the glass, not 1 in', { offsetIn: 2 }],
      ['Frame level with the glass, not 1 in in front', { offsetIn: 0 }],
      ['Taps on where the sharp corners would be, not on the tips', { rectScale: [ID1_CARD_MM.widthMm / inch.widthMm, ID1_CARD_MM.heightMm / inch.heightMm] }],
      ['Focal length 10% off (and still called 3%)', { focal35: FOCAL35_ASSUMED * 1.1 }],
    ];
    for (const [label, change] of rows) {
      const t = taps(shot, sc, { ...usual, ...change });
      const r = sizeFromCard({ widthPx: sc.widthPx, heightPx: sc.heightPx, focalPx: focalPxFrom35mm(FOCAL35_ASSUMED, sc.widthPx, sc.heightPx), cardCorners: t.card, windowCorners: t.win });
      if (r === null) throw new Error(`limits row not sizeable: ${label}`);
      console.log(row([label, signed(r.widthIn - shot.winW), signed(r.heightIn - shot.winH)]));
    }
    const base = sizeFromCard((() => {
      const t = taps(shot, sc, usual);
      return { widthPx: sc.widthPx, heightPx: sc.heightPx, focalPx: focalPxFrom35mm(FOCAL35_ASSUMED, sc.widthPx, sc.heightPx), cardCorners: t.card, windowCorners: t.win };
    })())!;
    console.log('');
    console.log(`For scale: the claimed ± of this photo is ${f2(base.uncertaintyIn.width)} in wide and ${f2(base.uncertaintyIn.height)} in tall.`);
  }

  console.log('');
  console.log('### Assumptions');
  console.log('');
  console.log(`- Tap noise: ${defaultTapSigmaPx(3024, 4032).toFixed(1)} px per coordinate (0.05% of the photo's long side, at least 1 px), on the card's and the window's corners. A careful fingertip with the magnifier.`);
  console.log(`- Frame offset in front of the glass: the sizing is told ${CARD_DEFAULT_OFFSET_IN} in; the truth is drawn from a normal with mean ${CARD_DEFAULT_OFFSET_IN} in and sigma ${CARD_OFFSET_SIGMA_IN} in each trial.`);
  console.log(`- Focal length: the sizing is told ${FOCAL35_ASSUMED} mm-equivalent; the truth is drawn from a normal with sigma ${FOCAL_SIGMA * 100}% each trial.`);
  console.log(`- Card: the tapped rectangle is the ID-1 card inset by its rounded corners (${ID1_TAP_RECT_MM.widthMm.toFixed(2)} x ${ID1_TAP_RECT_MM.heightMm.toFixed(2)} mm), each side drawn with sigma ${CARD_RECT_SIGMA_MM} mm; flat on the glass in the middle of the window, landscape or portrait at random, turned up to 10 degrees, tapped from a random corner in a random direction.`);
  console.log('- Photo: 12 MP, 3024 x 4032 (taken upright, as these windows are taller than wide), 26 mm-equivalent, no lens distortion, a flat rectangular window, pitch 0. The camera stands the stated distance from the glass, or farther back when the window would not fit in the photo.');
  console.log(`- ${TRIALS} trials per row or cell, seed ${SEED}. SYNTHETIC photos, not field data: real error will be larger until the field test.`);
}
