// Generates the parity cases for the Swift port of the card model, and the server's answer for each, by running the REAL
// TypeScript (packages/shared/src/window-photo-card.ts and window-photo-math.ts) the way the server's
// `sizePhotoWindow` card branch does:
//   1. cardProblem(...)                                         -> the sentence the 422 says (or null)
//   2. focalPx = focalPxFrom35mm(photo.focal35mm ?? 26, w, h); focalSigmaFrac = SHEET_FOCAL_UNKNOWN_SIGMA when the photo
//      has no focal length, else the default; sizeFromCard(...) -> the size (or null)
//
// Regenerate the Swift parity data whenever the server's card model (packages/shared/src/window-photo-card.ts) changes, from the
// repository root (Node 22, `npx tsx`):
//   npx tsx apps/ios/Core/scripts/card-parity/gen-cases.ts > /tmp/cases.json
//   node apps/ios/Core/scripts/card-parity/emit-swift.mjs /tmp/cases.json > apps/ios/Core/Sources/RooflineCoreCheckSuite/CardParityData.swift
// then `apps/ios/Core/scripts/check.sh`. A failing parity check after a server change means the Swift port (CardSizing.swift)
// must change the same way.
import { execSync } from 'node:child_process';
import { cardProblem, ID1_TAP_RECT_MM, inchesInWords, sizeFromCard } from '../../../../../packages/shared/src/window-photo-card.ts';
import { focalPxFrom35mm, type Pt, type Quad } from '../../../../../packages/shared/src/window-photo-math.ts';
import { SHEET_FOCAL_UNKNOWN_SIGMA } from '../../../../../packages/shared/src/window-photo-sheet.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic photos: a pinhole camera looking at a vertical wall (the tests' renderer, window-photo-card.test.ts). The glass
// is the plane z = 0 (x right, y down, inches, z into the wall); the card lies on it; the window frame's corners lie
// `offsetIn` in front of it (z = -offsetIn).

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

function camera(o: { distanceIn: number; yawDeg: number; pitchDeg: number; focalPx: number; w: number; h: number; target: V3 }) {
  const yaw = (o.yawDeg * Math.PI) / 180;
  const pitch = (o.pitchDeg * Math.PI) / 180;
  const C: V3 = [o.target[0] + o.distanceIn * Math.sin(yaw) * Math.cos(pitch), o.target[1] - o.distanceIn * Math.sin(pitch), -o.distanceIn * Math.cos(yaw) * Math.cos(pitch)];
  const f = unit(sub(o.target, C));
  const x = unit(cross(f, [0, -1, 0]));
  const y = cross(f, x);
  const project = (P: V3): Pt => {
    const d = sub(P, C);
    const cam = [x, y, f].map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]) as V3;
    return [o.focalPx * (cam[0] / cam[2]) + o.w / 2, o.focalPx * (cam[1] / cam[2]) + o.h / 2];
  };
  return { project, C };
}

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

type Shot = {
  winW: number;
  winH: number;
  yawDeg: number;
  pitchDeg?: number;
  rollDeg?: number;
  distanceIn: number;
  offsetIn: number;
  /** The photo's shape: tall (3024 x 4032) or wide (4032 x 3024). Default: tall for a window at least as tall as wide. */
  portrait?: boolean;
  /** Pixels, overriding the 12 MP default. */
  size?: [number, number];
  /** The lens the picture was taken with (35 mm equivalent). Default 26. */
  focal35?: number;
  /** Do not back the camera off to fit the window in the photo. */
  exact?: boolean;
};
type Placement = { portrait?: boolean; rotDeg?: number; centre?: [number, number]; rectScale?: [number, number] };
const IN_PER_MM = 1 / 25.4;
const M = 39.37;

/** One photo of a shot. The camera backs off from `distanceIn` until the window's corners are inside the photo (unless `exact`). The card's taps are at the TIPS of its rounded corners. */
function photo(s: Shot, c: Placement = {}) {
  const portrait = s.portrait ?? s.winH >= s.winW;
  const w = s.size ? s.size[0] : portrait ? 3024 : 4032;
  const h = s.size ? s.size[1] : portrait ? 4032 : 3024;
  const focalPx = focalPxFrom35mm(s.focal35 ?? 26, w, h);
  const target: V3 = [s.winW / 2, s.winH / 2, 0];
  let distanceIn = s.distanceIn;
  const roll = ((s.rollDeg ?? 0) * Math.PI) / 180;
  const rolled = (p: Pt): Pt => {
    if (roll === 0) return p;
    const dx = p[0] - w / 2;
    const dy = p[1] - h / 2;
    return [w / 2 + dx * Math.cos(roll) - dy * Math.sin(roll), h / 2 + dx * Math.sin(roll) + dy * Math.cos(roll)];
  };
  const make = () => camera({ distanceIn, yawDeg: s.yawDeg, pitchDeg: s.pitchDeg ?? 0, focalPx, w, h, target });
  const windowQuadOf = (cam: ReturnType<typeof make>) => ([[0, 0], [s.winW, 0], [s.winW, s.winH], [0, s.winH]] as Pt[]).map(([x, y]) => rolled(cam.project([x, y, -s.offsetIn]))) as Quad;
  let cam = make();
  for (let i = 0; i < 600 && s.exact !== true; i++) {
    if (windowQuadOf(cam).every((p) => p[0] > 0.05 * w && p[0] < 0.95 * w && p[1] > 0.05 * h && p[1] < 0.95 * h)) break;
    distanceIn *= 1.02;
    cam = make();
  }
  const centre = c.centre ?? [s.winW / 2, s.winH / 2];
  const rot = ((c.rotDeg ?? 0) + (c.portrait ? 90 : 0)) * (Math.PI / 180);
  const hw = (ID1_TAP_RECT_MM.widthMm * IN_PER_MM * (c.rectScale?.[0] ?? 1)) / 2;
  const hh = (ID1_TAP_RECT_MM.heightMm * IN_PER_MM * (c.rectScale?.[1] ?? 1)) / 2;
  const local: Pt[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const cardQuad = local.map(([u, v]) => rolled(cam.project([centre[0] + u * Math.cos(rot) - v * Math.sin(rot), centre[1] + u * Math.sin(rot) + v * Math.cos(rot), 0]))) as Quad;
  return { widthPx: w, heightPx: h, windowQuad: windowQuadOf(cam), cardQuad, distanceIn };
}

/** The four taps in another order: start at corner `start`, optionally going round the other way. */
function tapOrder(q: Quad, start: number, reverse: boolean): Quad {
  const a: Pt[] = reverse ? [q[0], q[3], q[2], q[1]] : [q[0], q[1], q[2], q[3]];
  return [0, 1, 2, 3].map((i) => a[(i + start) % 4]!) as Quad;
}

// ---------------------------------------------------------------------------------------------------------------------
// Cases

type Case = { name: string; widthPx: number; heightPx: number; focal35mm: number | null; card: Pt[]; win: Pt[] };
const cases: Case[] = [];
/** A tap as a person makes it: sub-pixel, to the hundredth of a pixel (so the numbers in the Swift file are short and exact). */
const r2 = (v: number) => Math.round(v * 100) / 100;
const roundQ = (q: readonly Pt[]): Pt[] => q.map((p) => [r2(p[0]), r2(p[1])] as Pt);

type Opts = { told?: number | null; order?: [number, boolean]; noise?: number; seed?: number; card?: Placement };
/** Adds a case from a shot. `told` is the focal length the photo says (null: it says nothing); default: the lens it was taken with. */
function add(name: string, shot: Shot, o: Opts = {}) {
  const p = photo(shot, o.card ?? {});
  let card: Quad = p.cardQuad;
  let win: Quad = p.windowQuad;
  if (o.noise !== undefined && o.noise > 0) {
    const g = gaussianFrom(mulberry32(o.seed ?? 1));
    const noisy = (q: Quad): Quad => q.map((pt) => [pt[0] + o.noise! * g(), pt[1] + o.noise! * g()] as Pt) as Quad;
    card = noisy(card);
    win = noisy(win);
  }
  if (o.order) card = tapOrder(card, o.order[0], o.order[1]);
  const told = o.told === undefined ? (shot.focal35 ?? 26) : o.told;
  cases.push({ name, widthPx: p.widthPx, heightPx: p.heightPx, focal35mm: told, card: roundQ(card), win: roundQ(win) });
  return cases[cases.length - 1]!;
}
/** Adds a case from explicit corners (a mistap, a broken photo). */
function raw(name: string, base: Case, change: Partial<Case>) {
  cases.push({ ...base, name, ...change });
}
const mid = (q: readonly Pt[]): Pt => [(q[0]![0] + q[2]![0]) / 2, (q[0]![1] + q[2]![1]) / 2];
const shrink = (q: readonly Pt[], k: number): Pt[] => {
  const m = mid(q);
  return q.map((p) => [r2(m[0] + (p[0] - m[0]) * k), r2(m[1] + (p[1] - m[1]) * k)] as Pt);
};
const put = (q: readonly Pt[], i: number, p: Pt): Pt[] => q.map((v, k) => (k === i ? p : v));

// 1. Window sizes, photographed from about 4 ft (48 in; the camera backs off when the window would not fit), 26 mm, card in the middle of the glass.
add('36x60 at 4 ft, card in the middle', { winW: 36, winH: 60, yawDeg: 8, pitchDeg: 2, distanceIn: 48, offsetIn: 1 });
add('24x36 at 4 ft', { winW: 24, winH: 36, yawDeg: 8, pitchDeg: 2, distanceIn: 48, offsetIn: 1 });
add('48x72 at 4 ft', { winW: 48, winH: 72, yawDeg: 8, pitchDeg: 2, distanceIn: 48, offsetIn: 1 });
add('60x40 wide window, 4032x3024 photo', { winW: 60, winH: 40, yawDeg: -10, pitchDeg: 0, distanceIn: 48, offsetIn: 1 });
add('12x18 small window up close', { winW: 12, winH: 18, yawDeg: 5, distanceIn: 36, offsetIn: 1 });
add('72x80 big window', { winW: 72, winH: 80, yawDeg: 10, distanceIn: 48, offsetIn: 1 });
add('square on, no pitch (viewAngle 0)', { winW: 36, winH: 60, yawDeg: 0, pitchDeg: 0, distanceIn: 60, offsetIn: 1 });

// 2. The sanity table: 24 mm lens (told 24 mm), about 4 ft, taps without noise (the model's default doubt is 2 px).
for (const [w, h] of [[24, 36], [36, 60], [48, 72], [60, 80]] as [number, number][]) {
  add(`table ${w}x${h}, 24 mm, 4 ft`, { winW: w, winH: h, yawDeg: 0, pitchDeg: 0, distanceIn: 48, offsetIn: 1, focal35: 24 });
}

// 3. The window seen at an angle: 20, 45, 55 degrees (steep above 50), and the other way.
for (const yaw of [20, 45, 55, -45, 58]) {
  add(`36x60 yaw ${yaw}`, { winW: 36, winH: 60, yawDeg: yaw, pitchDeg: 2, distanceIn: 48, offsetIn: 1 });
}
add('small window at 58 degrees (steep, but the doubt is small)', { winW: 6, winH: 9, yawDeg: 58, distanceIn: 1.2 * M, offsetIn: 1 });
add('camera pitched up 12 degrees', { winW: 36, winH: 60, yawDeg: 15, pitchDeg: 12, distanceIn: 48, offsetIn: 1 });
add('camera pitched down 10 degrees, rolled 8', { winW: 36, winH: 60, yawDeg: 15, pitchDeg: -10, rollDeg: 8, distanceIn: 48, offsetIn: 1 });
add('rolled 25 degrees', { winW: 30, winH: 48, yawDeg: 5, rollDeg: 25, distanceIn: 60, offsetIn: 1 });

// 4. The card: small in the photo, not a card's shape, and where it lies.
add('card small in the photo (12x18 from 5.5 m)', { winW: 12, winH: 18, yawDeg: 10, distanceIn: 5.5 * M, offsetIn: 1, exact: true });
add('card under 1.5% of the long side (24x36 from 4.5 m)', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 4.5 * M, offsetIn: 1, exact: true });
add('card tapped as 1 x 1.6 (not a card)', { winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1 }, { card: { rectScale: [1, 1.6] } });
add('card tapped 1.4 x 1 (not a card)', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 60, offsetIn: 1 }, { card: { rectScale: [1.4, 1] } });
add('card tapped 0.9 x 1.1 (within the shape tolerance)', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 60, offsetIn: 1 }, { card: { rectScale: [0.9, 1.1] } });
add('card portrait, turned 12 degrees', { winW: 36, winH: 60, yawDeg: 20, pitchDeg: 5, distanceIn: 60, offsetIn: 1 }, { card: { portrait: true, rotDeg: 12 } });
add('card in the corner of the glass', { winW: 36, winH: 60, yawDeg: 20, pitchDeg: -6, distanceIn: 60, offsetIn: 1.5 }, { card: { centre: [6, 8], rotDeg: -15 } });
add('card high on the glass, turned 30', { winW: 36, winH: 60, yawDeg: -20, pitchDeg: 4, distanceIn: 60, offsetIn: 0.5 }, { card: { centre: [20, 50], rotDeg: 30 } });


// 4b. Small windows near the camera: the card is a good share of them, and the ± is small enough to be 'good'.
add('15x20 at 3 ft', { winW: 15, winH: 20, yawDeg: 8, distanceIn: 36, offsetIn: 1 });
add('18x24 at 3 ft, 20 degrees', { winW: 18, winH: 24, yawDeg: 20, distanceIn: 36, offsetIn: 1 });
add('10x10 at 2.5 ft', { winW: 10, winH: 10, yawDeg: 0, distanceIn: 30, offsetIn: 1 });
add('20x14 wide, 4032x3024', { winW: 20, winH: 14, yawDeg: -15, distanceIn: 36, offsetIn: 1 });
add('12x18 no focal told', { winW: 12, winH: 18, yawDeg: 5, distanceIn: 36, offsetIn: 1 }, { told: null });
add('12x18 at 35 degrees (warn side of steep, still small)', { winW: 12, winH: 18, yawDeg: 35, distanceIn: 36, offsetIn: 1 });
add('window very small in the photo (24x36 from 100 m)', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 100 * 39.37, offsetIn: 1, exact: true });
add('window very small in the photo (12x18 from 30 m)', { winW: 12, winH: 18, yawDeg: 10, distanceIn: 30 * 39.37, offsetIn: 1, exact: true });

// 4c. The photo the app's old preview check used: front-on at 40 px per inch, 2250 x 3000, a card tapped at its full (sharp-corner) size.
{
  const s = 40;
  const cw = (85.6 / 25.4) * s;
  const ch = (53.98 / 25.4) * s;
  cases.push({
    name: 'front-on photo at 40 px per inch, 2250x3000, a full-size card (the old app check)',
    widthPx: 2250,
    heightPx: 3000,
    focal35mm: null,
    card: [[800, 1000], [800 + cw, 1000], [800 + cw, 1000 + ch], [800, 1000 + ch]].map(([x, y]) => [r2(x!), r2(y!)] as Pt),
    win: [[300, 400], [1725, 400], [1725, 2785], [300, 2785]],
  });
}

// 4d. The real answer printed in the homeowner API doc (docs/windows/homeowner-api.md, w-kitchen-1): a 36 x 60 window by card, 3024 x 4032, EXIF 26 mm.
cases.push({
  name: 'the API doc example: a 36 x 60 window by card, 26 mm (docs/windows/homeowner-api.md)',
  widthPx: 3024,
  heightPx: 4032,
  focal35mm: 26,
  card: [[1437, 1968], [1587, 1969], [1587, 2063], [1437, 2064]],
  win: [[644, 532], [2312, 675], [2312, 3357], [644, 3500]],
});

// 5. The lens: ultra wide (13 mm), 19.5 (just under), 20.5 (just over), 26, none told (26 assumed), 24 (told) and 50.
add('13 mm ultra wide lens', { winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1, focal35: 13 });
add('13 mm ultra wide lens, 36x60', { winW: 36, winH: 60, yawDeg: 10, distanceIn: 48, offsetIn: 1, focal35: 13 });
add('19.5 mm lens (wide)', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 48, offsetIn: 1, focal35: 19.5 });
add('20.5 mm lens', { winW: 24, winH: 36, yawDeg: 10, distanceIn: 48, offsetIn: 1, focal35: 20.5 });
add('26 mm lens told', { winW: 36, winH: 60, yawDeg: 25, pitchDeg: 3, distanceIn: 60, offsetIn: 1, focal35: 26 });
add('no focal length told, shot at 26 mm', { winW: 36, winH: 60, yawDeg: 25, pitchDeg: 3, distanceIn: 60, offsetIn: 1, focal35: 26 }, { told: null });
add('no focal length told, shot at 24 mm', { winW: 36, winH: 60, yawDeg: 25, pitchDeg: 3, distanceIn: 60, offsetIn: 1, focal35: 24 }, { told: null });
add('no focal length told, 13 mm lens (assumed 26)', { winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1, focal35: 13 }, { told: null });
add('50 mm lens', { winW: 36, winH: 60, yawDeg: 20, distanceIn: 120, offsetIn: 1, focal35: 50 });
add('told 28 mm but shot at 26 mm', { winW: 36, winH: 60, yawDeg: 30, distanceIn: 60, offsetIn: 1, focal35: 26 }, { told: 28 });
add('told 120 mm (telephoto) but shot at 26', { winW: 24, winH: 36, yawDeg: 12, distanceIn: 60, offsetIn: 1, focal35: 26 }, { told: 120 });

// 6. The photo: 3024x4032, 4032x3024, and others.
add('tall window, 3024x4032 photo', { winW: 30, winH: 54, yawDeg: 12, distanceIn: 60, offsetIn: 1, portrait: true });
add('tall window, 4032x3024 photo (turned the other way)', { winW: 30, winH: 54, yawDeg: 12, distanceIn: 60, offsetIn: 1, portrait: false });
add('wide window, 3024x4032 photo', { winW: 54, winH: 30, yawDeg: 12, distanceIn: 60, offsetIn: 1, portrait: true });
add('wide window, 4032x3024 photo', { winW: 54, winH: 30, yawDeg: 12, distanceIn: 60, offsetIn: 1, portrait: false });
add('2250x3000 photo', { winW: 36, winH: 60, yawDeg: 12, distanceIn: 60, offsetIn: 1, size: [2250, 3000] });
add('1500x2000 photo (default tap noise 1 px)', { winW: 36, winH: 60, yawDeg: 12, distanceIn: 60, offsetIn: 1, size: [1500, 2000] });
add('1200x900 photo (a small one)', { winW: 36, winH: 24, yawDeg: 12, distanceIn: 60, offsetIn: 1, size: [1200, 900] });
add('6000x4000 photo', { winW: 36, winH: 24, yawDeg: 12, distanceIn: 60, offsetIn: 1, size: [6000, 4000] });

// 7. Tap noise: a few pixels on every corner (seeded).
add('36x60 with 2 px noise (seed 1)', { winW: 36, winH: 60, yawDeg: 15, pitchDeg: 3, distanceIn: 48, offsetIn: 1 }, { noise: 2, seed: 1 });
add('36x60 with 2 px noise (seed 2)', { winW: 36, winH: 60, yawDeg: 15, pitchDeg: 3, distanceIn: 48, offsetIn: 1 }, { noise: 2, seed: 2 });
add('24x36 with 3 px noise', { winW: 24, winH: 36, yawDeg: 15, pitchDeg: 3, distanceIn: 48, offsetIn: 1 }, { noise: 3, seed: 3 });
add('48x72 with 5 px noise', { winW: 48, winH: 72, yawDeg: 25, pitchDeg: 0, distanceIn: 48, offsetIn: 1 }, { noise: 5, seed: 4 });
add('12x18 with 1 px noise', { winW: 12, winH: 18, yawDeg: 5, distanceIn: 36, offsetIn: 1 }, { noise: 1, seed: 5 });
add('36x60 with 8 px noise, no focal told', { winW: 36, winH: 60, yawDeg: 40, distanceIn: 60, offsetIn: 1 }, { noise: 8, seed: 6, told: null });

// 8. The card tapped clockwise, counter-clockwise, from another corner (one photo, 8 orders; then the same with a portrait card).
for (const reverse of [false, true]) {
  for (const start of [0, 1, 2, 3]) {
    add(`36x60 yaw 25, card ${reverse ? 'counter-clockwise' : 'clockwise'} from corner ${start}`, { winW: 36, winH: 60, yawDeg: 25, pitchDeg: 5, distanceIn: 60, offsetIn: 1 }, { order: [start, reverse], card: { rotDeg: 12 } });
  }
}
for (const [start, reverse] of [[0, false], [1, true], [2, false], [3, true]] as [number, boolean][]) {
  add(`portrait card, order ${start}${reverse ? ' reversed' : ''}, 55 degrees`, { winW: 36, winH: 60, yawDeg: 55, distanceIn: 60, offsetIn: 1 }, { order: [start, reverse], card: { portrait: true, rotDeg: -8 } });
}

// 9. Not sizeable: size is null.
const base = add('base: a good capture', { winW: 36, winH: 60, yawDeg: 15, distanceIn: 1.5 * M, offsetIn: 1 });
const card = base.card;
const win = base.win;
raw('card corners cross (bow tie)', base, { card: [card[0]!, card[2]!, card[1]!, card[3]!] });
raw('card is a dart (a corner pushed in)', base, { card: [card[0]!, card[1]!, [r2(card[0]![0] + 0.4 * (card[2]![0] - card[0]![0])), r2(card[0]![1] + 0.4 * (card[2]![1] - card[0]![1]))], card[3]!] });
raw('card: three corners in a line', base, { card: [card[0]!, [r2((card[0]![0] + card[1]![0]) / 2), r2((card[0]![1] + card[1]![1]) / 2)], card[1]!, card[2]!] });
raw('card: four corners in a line', base, { card: [card[0]!, [r2(card[0]![0] + 40), r2(card[0]![1] + 10)], [r2(card[0]![0] + 80), r2(card[0]![1] + 20)], [r2(card[0]![0] + 120), r2(card[0]![1] + 30)]] });
raw('card: two corners the same', base, { card: [card[0]!, card[1]!, card[1]!, card[3]!] });
raw('window corners cross (bow tie)', base, { win: [win[0]!, win[2]!, win[1]!, win[3]!] });
raw('window is a dart', base, { win: [win[0]!, win[1]!, [r2(win[0]![0] + 0.4 * (win[2]![0] - win[0]![0])), r2(win[0]![1] + 0.4 * (win[2]![1] - win[0]![1]))], win[3]!] });
raw('window: four corners in a line', base, { win: [win[0]!, [r2(win[0]![0] + 100), r2(win[0]![1] + 50)], [r2(win[0]![0] + 200), r2(win[0]![1] + 100)], [r2(win[0]![0] + 300), r2(win[0]![1] + 150)]] });
raw('window: three corners in a line', base, { win: [win[0]!, [r2((win[0]![0] + win[1]![0]) / 2), r2((win[0]![1] + win[1]![1]) / 2)], win[1]!, win[2]!] });
raw('card of three corners', base, { card: card.slice(0, 3) });
raw('window of five corners', base, { win: [...win, win[0]!] });
add('window too small (2 x 2.5 in)', { winW: 2, winH: 2.5, yawDeg: 0, distanceIn: 1 * M, offsetIn: 1, exact: true });
add('window too big (450 x 420 in)', { winW: 450, winH: 420, yawDeg: 0, distanceIn: 15 * M, offsetIn: 1, exact: true });
add('window only 2.9 in tall', { winW: 40, winH: 2.9, yawDeg: 0, distanceIn: 2 * M, offsetIn: 1, exact: true });
add('camera 0.9 in from the glass (closer than the frame offset)', { winW: 6, winH: 9, yawDeg: 0, distanceIn: 0.9, offsetIn: 0.5, exact: true });
{
  // A card off to the side of a steep view, past the vanishing line of the wall.
  const steep = photo({ winW: 36, winH: 60, yawDeg: 62, distanceIn: 2 * M, offsetIn: 1 });
  cases.push({ name: 'rays miss the plane (card past the wall horizon)', widthPx: steep.widthPx, heightPx: steep.heightPx, focal35mm: 26, card: steep.cardQuad.map(([x, y]) => [r2(x - steep.widthPx * 0.9), r2(y)] as Pt), win: roundQ(steep.windowQuad) });
}
add('very steep, 66 degrees', { winW: 36, winH: 60, yawDeg: 66, distanceIn: 2 * M, offsetIn: 1 });

// 10. cardProblem: every sentence (and the edges).
raw('problem: photo width 0', base, { widthPx: 0 });
raw('problem: photo height negative', base, { heightPx: -3 });
raw('problem: card corner outside (x past the right edge)', base, { card: put(card, 2, [base.widthPx + 40, 100]) });
raw('problem: window corner outside (x = -30)', base, { win: put(win, 0, [-30, 50]) });
raw('problem: window corner outside (y past the bottom)', base, { win: put(win, 3, [100, base.heightPx + 5]) });
raw('problem: window corner at x = -1 (inside)', base, { win: put(win, 0, [-1, win[0]![1]]) });
raw('problem: window corner at y = -1.01 (outside)', base, { win: put(win, 1, [win[1]![0], -1.01]) });
raw('problem: card outside and window outside (card first)', base, { card: put(card, 0, [-50, 10]), win: put(win, 0, [-30, 50]) });
raw('problem: card corners cross', base, { card: [card[0]!, card[2]!, card[1]!, card[3]!] });
raw('problem: card shape (a line)', base, { card: [card[0]!, [r2(card[0]![0] + 40), r2(card[0]![1] + 10)], [r2(card[0]![0] + 80), r2(card[0]![1] + 20)], [r2(card[0]![0] + 120), r2(card[0]![1] + 30)]] });
raw('problem: card is a dart', base, { card: [card[0]!, card[1]!, [r2(card[0]![0] + 0.4 * (card[2]![0] - card[0]![0])), r2(card[0]![1] + 0.4 * (card[2]![1] - card[0]![1]))], card[3]!] });
raw('problem: card too small (shrunk to 0.15)', base, { card: shrink(card, 0.15) });
raw('problem: card shrunk to half its size (fine, the ± is large)', base, { card: shrink(card, 0.5) });
raw('card tapped at a quarter of its size (the ± is huge)', base, { card: shrink(card, 0.25) });
raw('problem: card shrunk to 0.2 (just over the refusal line)', base, { card: shrink(card, 0.2) });
raw('problem: window corners cross', base, { win: [win[0]!, win[2]!, win[1]!, win[3]!] });
raw('problem: window shape (a line)', base, { win: [win[0]!, [r2(win[0]![0] + 100), r2(win[0]![1] + 50)], [r2(win[0]![0] + 200), r2(win[0]![1] + 100)], [r2(win[0]![0] + 300), r2(win[0]![1] + 150)]] });
raw('problem: window is a dart', base, { win: [win[0]!, win[1]!, [r2(win[0]![0] + 0.4 * (win[2]![0] - win[0]![0])), r2(win[0]![1] + 0.4 * (win[2]![1] - win[0]![1]))], win[3]!] });
raw('problem: card bigger than the window (swapped)', base, { card: win, win: card });
// The card/window area rule: the card's area at or above half the window's is "bigger" (a window 1800 x 1400 px = 2 520 000; half = 1 260 000).
const WIN_BOX: Pt[] = [[500, 500], [2300, 500], [2300, 1900], [500, 1900]];
const box = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
raw('problem: card area just under half the window (1400 x 899)', base, { card: box(600, 600, 1400, 899), win: WIN_BOX });
raw('problem: card area exactly half the window (1400 x 900)', base, { card: box(600, 600, 1400, 900), win: WIN_BOX });
raw('problem: card area just over half the window (1400 x 901)', base, { card: box(600, 600, 1400, 901), win: WIN_BOX });
raw('problem: card well under half the window', base, { card: box(1000, 1000, 700, 700), win: WIN_BOX });

// The "inside the photo" edge: a point may be 1 px outside (1000 x 800 photo, a card at the right and bottom edges).
const small = { widthPx: 1000, heightPx: 800 };
const smallWin = box(100, 100, 850, 600);
raw('problem: card corner at x = width + 1 (inside)', base, { ...small, card: box(900, 300, 101, 64), win: smallWin });
raw('problem: card corner at x = width + 1.01 (outside)', base, { ...small, card: box(900, 300, 101.01, 64), win: smallWin });
raw('problem: card corner at y = height + 1 (inside)', base, { ...small, card: box(500, 737, 101, 64), win: smallWin });
raw('problem: card corner at y = height + 1.01 (outside)', base, { ...small, card: box(500, 737, 101, 64.01), win: smallWin });
raw('problem: card corner at x = -1 (inside)', base, { ...small, card: box(-1, 300, 101, 64), win: smallWin });
raw('problem: card corner at x = -1.01 (outside)', base, { ...small, card: box(-1.01, 300, 101, 64), win: smallWin });
raw('problem: window corner at x = width + 1 (inside)', base, { ...small, card: box(300, 300, 101, 64), win: box(150, 100, 851, 600) });
raw('problem: window corner at x = width + 1.01 (outside)', base, { ...small, card: box(300, 300, 101, 64), win: box(150, 100, 851.01, 600) });
raw('problem: window corner at y = height + 1 (inside)', base, { ...small, card: box(300, 300, 101, 64), win: box(100, 101, 850, 700) });
raw('problem: window corner at y = height + 1.01 (outside)', base, { ...small, card: box(300, 300, 101, 64), win: box(100, 101, 850, 700.01) });
raw('problem: a card on the glass in a small photo (fine)', base, { ...small, card: box(300, 300, 101, 64), win: smallWin });
raw('problem: card long side just over 0.75% of the photo (7.51 px of 1000)', base, { ...small, card: box(300, 300, 7.51, 4.74), win: smallWin });
raw('problem: card long side just under 0.75% of the photo (7.49 px of 1000)', base, { ...small, card: box(300, 300, 7.49, 4.72), win: smallWin });
raw('problem: card corners cross the other way (second diagonal pair)', base, { card: [card[0]!, card[1]!, card[3]!, card[2]!] });
raw('problem: window corners cross the other way (second diagonal pair)', base, { win: [win[0]!, win[1]!, win[3]!, win[2]!] });
raw('problem: card corners with NaN', base, { card: put(card, 1, [Number.NaN, 5]) });
raw('problem: window corners with Infinity', base, { win: put(win, 1, [Number.POSITIVE_INFINITY, 5]) });
raw('problem: card of three corners', base, { card: card.slice(0, 3) });
raw('problem: window of five corners', base, { win: [...win, win[0]!] });

// 11. A sweep of random shots (seeded): sizes, angles, lenses, cards, noise, tap orders, photo shapes.
{
  const rnd = mulberry32(20261016);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const between = (a: number, b: number) => a + (b - a) * rnd();
  const g = gaussianFrom(rnd);
  const lenses: (number | null)[] = [null, 13, 24, 26, 26, 28, 35, 50, 120];
  for (let i = 0; i < 70; i++) {
    const winW = Math.round(between(10, 90) * 4) / 4;
    const winH = Math.round(between(10, 90) * 4) / 4;
    const told = pick(lenses);
    const truth = told === null ? pick([24, 26, 28]) : told;
    const shot: Shot = {
      winW,
      winH,
      yawDeg: Math.round(between(-58, 58) * 10) / 10,
      pitchDeg: Math.round(between(-12, 12) * 10) / 10,
      rollDeg: rnd() < 0.25 ? Math.round(between(-20, 20) * 10) / 10 : 0,
      distanceIn: between(30, 160),
      offsetIn: Math.round(between(0, 2) * 10) / 10,
      portrait: rnd() < 0.5 ? undefined : rnd() < 0.5,
      size: rnd() < 0.2 ? pick([[2250, 3000], [3000, 2250], [1500, 2000], [6000, 4000]] as [number, number][]) : undefined,
      focal35: truth,
    };
    const odd = rnd() < 0.12;
    const card: Placement = {
      portrait: rnd() < 0.5,
      rotDeg: Math.round(between(-45, 45)),
      centre: [winW * between(0.15, 0.85), winH * between(0.15, 0.85)],
      rectScale: odd ? [between(0.7, 1.5), between(0.7, 1.5)] : [1 + 0.01 * g(), 1 + 0.01 * g()],
    };
    const sigma = pick([0, 0, 1, 2, 2, 4]);
    add(`random ${i + 1}`, shot, { told, card, noise: sigma, seed: 100 + i, order: [Math.floor(rnd() * 4), rnd() < 0.5] });
  }
}

// 10b. Mistaps: one corner of a good capture moved somewhere else (seeded). Whatever shape that makes, the server's verdict is the truth.
{
  const rnd = mulberry32(4242);
  const goodShot: Shot = { winW: 30, winH: 48, yawDeg: 18, pitchDeg: 3, distanceIn: 48, offsetIn: 1 };
  const g0 = photo(goodShot);
  const gc = roundQ(g0.cardQuad);
  const gw = roundQ(g0.windowQuad);
  for (let i = 0; i < 60; i++) {
    const onCard = rnd() < 0.5;
    const k = Math.floor(rnd() * 4);
    const q = (onCard ? gc : gw).map((p) => [p[0], p[1]] as Pt);
    const reach = onCard ? 400 : 1200;
    const how = rnd();
    q[k] = how < 0.5 ? [r2(q[k]![0] + (rnd() - 0.5) * 2 * reach), r2(q[k]![1] + (rnd() - 0.5) * 2 * reach)] : [r2(rnd() * g0.widthPx), r2(rnd() * g0.heightPx)];
    cases.push({ name: `mistap ${i + 1}: ${onCard ? 'card' : 'window'} corner ${k} moved`, widthPx: g0.widthPx, heightPx: g0.heightPx, focal35mm: 26, card: onCard ? q : gc, win: onCard ? gw : q });
  }
}

// 10c. Photos whose points are all inside the picture, so the 422 rules pass, yet the geometry has no answer (a card tapped
// beyond the horizon of the plane the window lies in, so its rays miss that plane): found by a seeded search over cards
// dropped anywhere in a steep view.
{
  const rnd = mulberry32(777);
  const between = (a: number, b: number) => a + (b - a) * rnd();
  let found = 0;
  for (let t = 0; t < 20000 && found < 6; t++) {
    const p = photo({ winW: 36, winH: 60, yawDeg: between(55, 80), pitchDeg: between(-8, 8), distanceIn: 2 * M, offsetIn: 1, focal35: 26 });
    const w = between(120, 420);
    const h = w / 1.586;
    const cx = between(0.05, 0.95) * p.widthPx;
    const cy = between(0.05, 0.95) * p.heightPx;
    const a = between(-0.8, 0.8);
    const q: Pt[] = ([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as Pt[]).map(([u, v]) => [r2(cx + u * Math.cos(a) - v * Math.sin(a)), r2(cy + u * Math.sin(a) + v * Math.cos(a))] as Pt);
    const c: Case = { name: `no answer from the geometry (search ${found + 1})`, widthPx: p.widthPx, heightPx: p.heightPx, focal35mm: 26, card: q, win: roundQ(p.windowQuad) };
    const v = server(c);
    if (v.problem === null && v.size === null) {
      cases.push(c);
      found++;
    }
  }
  if (found === 0) throw new Error('the search found no photo the geometry cannot size');
}

// ---------------------------------------------------------------------------------------------------------------------
// The server's answers (the card branch of sizePhotoWindow in apps/api/src/estimator/window-uploads.ts)

function server(c: Case) {
  const problem = cardProblem({ widthPx: c.widthPx, heightPx: c.heightPx, cardCorners: c.card as Quad, windowCorners: c.win as Quad, card: { widthMm: 85.6, heightMm: 53.98 } });
  const focalPx = focalPxFrom35mm(c.focal35mm ?? 26, c.widthPx, c.heightPx);
  const focalSigmaFrac = c.focal35mm === null ? SHEET_FOCAL_UNKNOWN_SIGMA : undefined;
  const size = sizeFromCard({ widthPx: c.widthPx, heightPx: c.heightPx, focalPx, ...(focalSigmaFrac !== undefined && { focalSigmaFrac }), cardCorners: c.card as Quad, windowCorners: c.win as Quad });
  return { problem, size };
}

// The low-level entry point with explicit options (focal length in px, focal doubt, plane offset, tap noise).
type Low = { name: string; widthPx: number; heightPx: number; focalPx: number; focalSigmaFrac: number | null; planeOffsetIn: number | null; tapSigmaPx: number | null; card: Pt[]; win: Pt[] };
const low: Low[] = [];
{
  const b = photo({ winW: 36, winH: 60, yawDeg: 22, pitchDeg: 4, distanceIn: 52, offsetIn: 1 });
  const bc = roundQ(b.cardQuad);
  const bw = roundQ(b.windowQuad);
  const f26 = focalPxFrom35mm(26, b.widthPx, b.heightPx);
  const mk = (name: string, o: Partial<Low> = {}) =>
    low.push({ name, widthPx: b.widthPx, heightPx: b.heightPx, focalPx: f26, focalSigmaFrac: null, planeOffsetIn: null, tapSigmaPx: null, card: bc, win: bw, ...o });
  mk('defaults');
  for (const off of [0, 0.5, 1, 2, -1, -6, 6, 6.01, -6.01, Number.NaN, Number.POSITIVE_INFINITY]) mk(`plane offset ${off}`, { planeOffsetIn: off });
  for (const tap of [0, 0.2, 1, 2.016, 8, 50, -1, Number.NaN, Number.POSITIVE_INFINITY]) mk(`tap sigma ${tap}`, { tapSigmaPx: tap });
  for (const fs of [0, 0.03, 0.1, 0.5, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) mk(`focal sigma ${fs}`, { focalSigmaFrac: fs });
  for (const fp of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 100, 1e6, 2912, 2000, 4000]) mk(`focalPx ${fp}`, { focalPx: fp });
  for (const [w, h] of [[Number.NaN, 4032], [3024, Number.NaN], [Number.POSITIVE_INFINITY, 4032], [0, 4032], [3024, 0], [-3024, 4032], [4032, 3024], [2000, 2000]] as [number, number][]) mk(`photo ${w}x${h}`, { widthPx: w, heightPx: h });
  mk('everything set', { planeOffsetIn: -1, tapSigmaPx: 0.2, focalSigmaFrac: 0.1, focalPx: 2500 });
  mk('everything zero', { planeOffsetIn: 0, tapSigmaPx: 0, focalSigmaFrac: 0 });
  mk('offset 0 with no doubt anywhere else', { planeOffsetIn: 0, tapSigmaPx: 0, focalSigmaFrac: 0, focalPx: 3500 });
}
const lowOut = low.map((c) => {
  const size = sizeFromCard({
    widthPx: c.widthPx,
    heightPx: c.heightPx,
    focalPx: c.focalPx,
    ...(c.focalSigmaFrac !== null && { focalSigmaFrac: c.focalSigmaFrac }),
    ...(c.planeOffsetIn !== null && { planeOffsetIn: c.planeOffsetIn }),
    ...(c.tapSigmaPx !== null && { tapSigmaPx: c.tapSigmaPx }),
    cardCorners: c.card as Quad,
    windowCorners: c.win as Quad,
  });
  return { ...c, size };
});

// inchesInWords, which the reasons quote.
const wordInputs = [0, -1, Number.NaN, 1e-12, 0.001, 0.0625, 0.125, 0.1250001, 0.2, 0.25, 0.3, 0.375, 0.375000001, 0.4, 0.5, 0.6, 0.7, 0.75, 0.875, 0.99, 1, 1.01, 1.125, 1.2, 1.25, 1.5, 1.9, 2, 2.01, 2.5, 3, 3.3, 3.5, 3.875, 3.999, 4, 4.0000001, 4.2, 5, 5.5, 6, 10.01, 99.9, 100, 1234.5, 5e5, 1e9, 0.375 + 1e-12, 0.375 + 1e-8, 1 + 1e-12, 1 + 1e-8, 4 + 1e-12, 3.9999999999, 3.99999, 0.125 + 1e-13, 2.5 + 1e-10, 7, 7.0000001, 0.1];
const words = wordInputs.map((v) => ({ inches: v, words: inchesInWords(v) }));

const out = cases.map((c) => ({ ...c, server: server(c) }));
// NaN and Infinity cannot be JSON: they travel as the strings "NaN", "Infinity" and "-Infinity".
// The repository root: this file is apps/ios/Core/scripts/card-parity/gen-cases.ts
const api = new URL('../../../../../', import.meta.url).pathname;
const git = (cmd: string) => execSync(`git -C ${api} ${cmd}`).toString().trim();
const meta = { branch: git('rev-parse --abbrev-ref HEAD'), head: git('rev-parse --short=8 HEAD'), cardFileCommit: git('log -1 --format=%h -- packages/shared/src/window-photo-card.ts'), dirty: git('status --porcelain -- packages apps/api/src/estimator') !== '' };
process.stdout.write(JSON.stringify({ meta, cases: out, low: lowOut, words }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 1));
