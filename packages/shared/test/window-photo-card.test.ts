import { describe, expect, it } from 'vitest';
import {
  CARD_CHECK_UNCERTAINTY_IN,
  CARD_DEFAULT_OFFSET_IN,
  CARD_MIN_LONG_SIDE_FRAC,
  cardProblem,
  defaultTapSigmaPx,
  ID1_CARD_MM,
  ID1_CORNER_RADIUS_MM,
  ID1_TAP_RECT_MM,
  ID1_TIP_INSET_MM,
  inchesInWords,
  sizeFromCard,
  type CardSize,
  type CardSizeInput,
} from '../src/window-photo-card.ts';
import { DEFAULT_FOCAL_35MM, focalPxFrom35mm, type Pt, type Quad } from '../src/window-photo-math.ts';
import { SHEET_FOCAL_UNKNOWN_SIGMA, STEEP_CHECK_DEG } from '../src/window-photo-sheet.ts';

// Synthetic photos: a pinhole camera looking at a vertical wall. The glass is the plane z = 0 (x right, y down, inches,
// z into the wall); the card lies on it; the window frame's corners lie `offsetIn` in front of it (z = -offsetIn).

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A camera `distanceIn` from the target on the glass, swung by yaw (about the vertical) and pitch, looking at the target. */
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

type Shot = { winW: number; winH: number; yawDeg: number; pitchDeg?: number; distanceIn: number; offsetIn: number; portrait?: boolean; focal35?: number; exact?: boolean };
type Placement = { portrait?: boolean; rotDeg?: number; centre?: Pt; rectScale?: [number, number] };
const IN_PER_MM = 1 / 25.4;
const M = 39.37;

/**
 * One photo of a shot: 3024 x 4032 for a tall window, 4032 x 3024 otherwise, 26 mm-equivalent. The camera backs off
 * from `distanceIn` until the window's corners are inside the photo (unless `exact`). The card's taps are at the TIPS of
 * its rounded corners, as a person taps them.
 */
function photo(s: Shot, c: Placement = {}) {
  const portrait = s.portrait ?? s.winH >= s.winW;
  const w = portrait ? 3024 : 4032;
  const h = portrait ? 4032 : 3024;
  const focalPx = focalPxFrom35mm(s.focal35 ?? 26, w, h);
  const target: V3 = [s.winW / 2, s.winH / 2, 0];
  let distanceIn = s.distanceIn;
  const make = () => camera({ distanceIn, yawDeg: s.yawDeg, pitchDeg: s.pitchDeg ?? 0, focalPx, w, h, target });
  const windowQuadOf = (cam: ReturnType<typeof make>) => ([[0, 0], [s.winW, 0], [s.winW, s.winH], [0, s.winH]] as Pt[]).map(([x, y]) => cam.project([x, y, -s.offsetIn])) as Quad;
  let cam = make();
  for (let i = 0; i < 400 && s.exact !== true; i++) {
    if (windowQuadOf(cam).every((p) => p[0] > 0.05 * w && p[0] < 0.95 * w && p[1] > 0.05 * h && p[1] < 0.95 * h)) break;
    distanceIn *= 1.02;
    cam = make();
  }
  const centre = c.centre ?? [s.winW / 2, s.winH / 2];
  const rot = ((c.rotDeg ?? 0) + (c.portrait ? 90 : 0)) * (Math.PI / 180);
  const hw = (ID1_TAP_RECT_MM.widthMm * IN_PER_MM * (c.rectScale?.[0] ?? 1)) / 2;
  const hh = (ID1_TAP_RECT_MM.heightMm * IN_PER_MM * (c.rectScale?.[1] ?? 1)) / 2;
  const local: Pt[] = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  const cardQuad = local.map(([u, v]) => cam.project([centre[0] + u * Math.cos(rot) - v * Math.sin(rot), centre[1] + u * Math.sin(rot) + v * Math.cos(rot), 0])) as Quad;
  return { widthPx: w, heightPx: h, focalPx, windowQuad: windowQuadOf(cam), cardQuad, distanceIn };
}

/** The four taps in another order: start at corner `start`, optionally going round the other way. */
function tapOrder(q: Quad, start: number, reverse: boolean): Quad {
  const a: Pt[] = reverse ? [q[0], q[3], q[2], q[1]] : [q[0], q[1], q[2], q[3]];
  return [0, 1, 2, 3].map((i) => a[(i + start) % 4]!) as Quad;
}
/** All 16 ways a person might tap a card: portrait or landscape on the glass, either winding, any starting corner. */
const LAYOUTS = [false, true].flatMap((portrait) => [false, true].flatMap((reverse) => [0, 1, 2, 3].map((start) => ({ portrait, reverse, start }))));

const inputOf = (p: ReturnType<typeof photo>, extra: Partial<CardSizeInput> = {}): CardSizeInput => ({
  widthPx: p.widthPx,
  heightPx: p.heightPx,
  focalPx: p.focalPx,
  cardCorners: p.cardQuad,
  windowCorners: p.windowQuad,
  ...extra,
});
const maxU = (r: CardSize) => Math.max(r.uncertaintyIn.width, r.uncertaintyIn.height);
const SIZES: [number, number][] = [[24, 36], [36, 60], [48, 72], [72, 80]];

describe('the card and its rounded corners', () => {
  it('is the ID-1 size, and the taps make the card inset by the rounding of the corners', () => {
    expect(ID1_CARD_MM).toEqual({ widthMm: 85.6, heightMm: 53.98 });
    expect(ID1_CORNER_RADIUS_MM).toBe(3.18);
    expect(ID1_TIP_INSET_MM).toBeCloseTo(0.9314, 3);
    expect(ID1_TAP_RECT_MM.widthMm).toBeCloseTo(83.74, 2);
    expect(ID1_TAP_RECT_MM.heightMm).toBeCloseTo(52.12, 2);
    expect(CARD_CHECK_UNCERTAINTY_IN).toBe(3 / 8);
    expect(CARD_DEFAULT_OFFSET_IN).toBe(1);
  });

  it('puts the default tap noise at 0.05% of the photo, at least 1 px', () => {
    expect(defaultTapSigmaPx(4032, 3024)).toBeCloseTo(2.016, 6);
    expect(defaultTapSigmaPx(1000, 800)).toBe(1);
  });
});

describe('without noise', () => {
  it('recovers the window within 0.1 in: sizes x yaw x camera distance x frame offset x photo shape x card layout', () => {
    let n = 0;
    let worst = 0;
    for (const [winW, winH] of SIZES) {
      for (const yawDeg of [0, 15, 30, 45]) {
        for (const metres of [1.2, 2, 3]) {
          for (const offsetIn of [0.5, 1, 1.5]) {
            for (const portrait of [true, false]) {
              const layout = LAYOUTS[n % LAYOUTS.length]!;
              const p = photo({ winW, winH, yawDeg, pitchDeg: n % 3 === 0 ? 8 : 0, distanceIn: metres * M, offsetIn, portrait }, { portrait: layout.portrait, rotDeg: (n % 7) * 3 - 9 });
              const r = sizeFromCard(inputOf(p, { cardCorners: tapOrder(p.cardQuad, layout.start, layout.reverse), planeOffsetIn: offsetIn }));
              expect(r, `${winW}x${winH} yaw ${yawDeg} ${metres} m offset ${offsetIn}`).not.toBeNull();
              worst = Math.max(worst, Math.abs(r!.widthIn - winW), Math.abs(r!.heightIn - winH));
              n++;
            }
          }
        }
      }
    }
    expect(n).toBe(288);
    expect(worst).toBeLessThan(0.1);
  });

  it('reads the card the same way however it lies and however it is tapped (16 ways), at several yaw angles', () => {
    for (const yawDeg of [0, 25, 45]) {
      const first = new Map<boolean, CardSize>();
      for (const layout of LAYOUTS) {
        const p = photo({ winW: 36, winH: 60, yawDeg, pitchDeg: 5, distanceIn: 2 * M, offsetIn: 1 }, { portrait: layout.portrait, rotDeg: 12 });
        const r = sizeFromCard(inputOf(p, { cardCorners: tapOrder(p.cardQuad, layout.start, layout.reverse) }))!;
        expect(r.widthIn).toBeCloseTo(36, 6);
        expect(r.heightIn).toBeCloseTo(60, 6);
        // The same card on the glass read from any of its 8 tap orders gives the same ± to the last digit.
        const ref = first.get(layout.portrait) ?? r;
        first.set(layout.portrait, ref);
        expect(r.uncertaintyIn.width).toBeCloseTo(ref.uncertaintyIn.width, 9);
        expect(r.uncertaintyIn.height).toBeCloseTo(ref.uncertaintyIn.height, 9);
      }
    }
  });

  it('does not care where on the glass the card is', () => {
    for (const centre of [[6, 8], [30, 50], [18, 30], [5, 52]] as Pt[]) {
      const p = photo({ winW: 36, winH: 60, yawDeg: 20, pitchDeg: -6, distanceIn: 2 * M, offsetIn: 1.5 }, { centre, rotDeg: -15 });
      const r = sizeFromCard(inputOf(p, { planeOffsetIn: 1.5 }))!;
      expect(r.widthIn).toBeCloseTo(36, 6);
      expect(r.heightIn).toBeCloseTo(60, 6);
    }
  });

  it('tells the card long side where a comparison of pixel lengths would be wrong (a landscape card at 55 to 60 degrees)', () => {
    for (const yawDeg of [55, 58, 60]) {
      for (const portrait of [false, true]) {
        const p = photo({ winW: 36, winH: 60, yawDeg, distanceIn: 2 * M, offsetIn: 1 }, { portrait });
        const side = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
        const q = p.cardQuad;
        const across = (side(q[0], q[1]) + side(q[3], q[2])) / 2;
        const down = (side(q[0], q[3]) + side(q[1], q[2])) / 2;
        // The card is turned across the photo's width: in pixels its long side looks the SHORTER one.
        if (!portrait) expect(across).toBeLessThan(down);
        const r = sizeFromCard(inputOf(p))!;
        expect(r.widthIn).toBeCloseTo(36, 6);
        expect(r.heightIn).toBeCloseTo(60, 6);
      }
    }
  });

  it('reports the distance to the glass, the angle off square and the size ratio', () => {
    const p = photo({ winW: 36, winH: 60, yawDeg: 30, distanceIn: 100, offsetIn: 1, exact: true });
    const r = sizeFromCard(inputOf(p))!;
    expect(r.distanceIn).toBeCloseTo(100 * Math.cos((30 * Math.PI) / 180), 0);
    expect(r.viewAngleDeg).toBeGreaterThan(29);
    expect(r.viewAngleDeg).toBeLessThan(31);
    expect(r.sizeRatio).toBeCloseTo(60 / (ID1_CARD_MM.widthMm / 25.4), 6);
  });

  it('gives the same size with a different tap noise or focal doubt, only a different ±', () => {
    const p = photo({ winW: 48, winH: 72, yawDeg: 35, distanceIn: 2 * M, offsetIn: 1 });
    const a = sizeFromCard(inputOf(p))!;
    const b = sizeFromCard(inputOf(p, { tapSigmaPx: 8 }))!;
    const c = sizeFromCard(inputOf(p, { focalSigmaFrac: SHEET_FOCAL_UNKNOWN_SIGMA }))!;
    expect(b.widthIn).toBe(a.widthIn);
    expect(c.heightIn).toBe(a.heightIn);
    expect(maxU(b)).toBeGreaterThan(2 * maxU(a));
    expect(c.uncertaintyIn.height).toBeGreaterThan(a.uncertaintyIn.height);
  });
});

describe('with tap noise, against the ± it claims', () => {
  /** Truth varies as the ± assumes: taps 2 px (default), offset 1 +- 0.5 in, focal length +- 3%, the card's tapped rectangle +- 0.5 mm. */
  function monteCarlo(shot: Shot, trials: number, seed: number, o: { tapSigmaPx?: number; focalSigma?: number } = {}) {
    const rnd = mulberry32(seed);
    const g = gaussianFrom(rnd);
    const base = photo(shot);
    const fixed: Shot = { ...shot, distanceIn: base.distanceIn, exact: true };
    const focalSigma = o.focalSigma ?? 0.03;
    let in1 = 0;
    let in2 = 0;
    let total = 0;
    const abs: number[] = [];
    const claimed: number[] = [];
    for (let i = 0; i < trials; i++) {
      const rectScale: [number, number] = [1 + (0.5 * g()) / ID1_TAP_RECT_MM.widthMm, 1 + (0.5 * g()) / ID1_TAP_RECT_MM.heightMm];
      const p = photo({ ...fixed, offsetIn: 1 + 0.5 * g(), focal35: 26 * (1 + focalSigma * g()) }, { portrait: rnd() < 0.5, rotDeg: (rnd() - 0.5) * 20, rectScale });
      const sigma = o.tapSigmaPx ?? defaultTapSigmaPx(p.widthPx, p.heightPx);
      const noisy = (q: Quad): Quad => q.map((pt) => [pt[0] + sigma * g(), pt[1] + sigma * g()] as Pt) as Quad;
      // The estimator is told 26 mm and offset 1: it does not know the draws.
      const r = sizeFromCard({ ...inputOf(p), focalPx: focalPxFrom35mm(26, p.widthPx, p.heightPx), cardCorners: tapOrder(noisy(p.cardQuad), Math.floor(rnd() * 4), rnd() < 0.5), windowCorners: noisy(p.windowQuad), tapSigmaPx: sigma, focalSigmaFrac: focalSigma })!;
      const ew = Math.abs(r.widthIn - shot.winW);
      const eh = Math.abs(r.heightIn - shot.winH);
      in1 += (ew <= r.uncertaintyIn.width ? 1 : 0) + (eh <= r.uncertaintyIn.height ? 1 : 0);
      in2 += (ew <= 2 * r.uncertaintyIn.width ? 1 : 0) + (eh <= 2 * r.uncertaintyIn.height ? 1 : 0);
      total += 2;
      abs.push(Math.max(ew, eh));
      claimed.push(maxU(r));
    }
    return { cov1: in1 / total, cov2: in2 / total, abs, claimed };
  }

  it('about 68% of the real errors fall inside 1 sigma and nearly all inside 2 sigma, in every kind of shot', () => {
    const shots: Shot[] = [
      { winW: 24, winH: 36, yawDeg: 15, pitchDeg: 3, distanceIn: 1.5 * M, offsetIn: 1 },
      { winW: 48, winH: 72, yawDeg: 15, pitchDeg: 3, distanceIn: 1.5 * M, offsetIn: 1 },
      { winW: 36, winH: 60, yawDeg: 40, pitchDeg: 5, distanceIn: 2.5 * M, offsetIn: 1 },
      { winW: 72, winH: 80, yawDeg: 0, pitchDeg: 0, distanceIn: 1.5 * M, offsetIn: 1 },
      { winW: 36, winH: 48, yawDeg: 20, pitchDeg: 0, distanceIn: 1 * M, offsetIn: 1 },
    ];
    shots.forEach((shot, k) => {
      const mc = monteCarlo(shot, 300, 100 + k);
      expect(mc.cov1, `1 sigma, ${shot.winW}x${shot.winH} yaw ${shot.yawDeg}`).toBeGreaterThan(0.55);
      expect(mc.cov1).toBeLessThan(0.85);
      expect(mc.cov2, `2 sigma, ${shot.winW}x${shot.winH} yaw ${shot.yawDeg}`).toBeGreaterThanOrEqual(0.9);
    });
  });

  it('stays calibrated when the focal length was assumed (10% doubt) and when the taps are sloppier', () => {
    const shot: Shot = { winW: 36, winH: 60, yawDeg: 40, pitchDeg: 3, distanceIn: 2 * M, offsetIn: 1 };
    const unknown = monteCarlo(shot, 300, 7, { focalSigma: SHEET_FOCAL_UNKNOWN_SIGMA });
    expect(unknown.cov1).toBeGreaterThan(0.55);
    expect(unknown.cov1).toBeLessThan(0.85);
    expect(unknown.cov2).toBeGreaterThanOrEqual(0.9);
    const sloppy = monteCarlo(shot, 300, 8, { tapSigmaPx: 6 });
    expect(sloppy.cov1).toBeGreaterThan(0.55);
    expect(sloppy.cov2).toBeGreaterThanOrEqual(0.9);
    // ... and the ± it claims for the sloppier taps is larger, with the real error larger too.
    const careful = monteCarlo(shot, 300, 8);
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(med(sloppy.claimed)).toBeGreaterThan(1.5 * med(careful.claimed));
    expect(med(sloppy.abs)).toBeGreaterThan(1.5 * med(careful.abs));
  });

  it('never reads the card the wrong way round, even at 58 degrees (a wrong way round is 35% off)', () => {
    const mc = monteCarlo({ winW: 36, winH: 60, yawDeg: 58, pitchDeg: 0, distanceIn: 2 * M, offsetIn: 1 }, 300, 21);
    expect(Math.max(...mc.abs)).toBeLessThan(0.1 * 60);
  });
});

describe('the ± and the quality', () => {
  it('grows with the size of the window at a fixed camera distance and angle, and with the size ratio', () => {
    const sizes: [number, number][] = [[12, 18], [24, 36], [36, 60], [48, 72], [72, 80]];
    const rs = sizes.map(([winW, winH]) => sizeFromCard(inputOf(photo({ winW, winH, yawDeg: 15, pitchDeg: 3, distanceIn: 3 * M, offsetIn: 1, exact: true })))!);
    for (let i = 1; i < rs.length; i++) {
      expect(maxU(rs[i]!)).toBeGreaterThan(maxU(rs[i - 1]!));
      expect(rs[i]!.sizeRatio).toBeGreaterThan(rs[i - 1]!.sizeRatio);
    }
    // A 72 in window is far less certain than a 24 in one (the ± scales with the size).
    expect(maxU(rs[4]!)).toBeGreaterThan(2 * maxU(rs[1]!));
    // The typical shot (48 x 72 at 1.5 m, 15 degrees) claims about an inch.
    const typical = sizeFromCard(inputOf(photo({ winW: 48, winH: 72, yawDeg: 15, pitchDeg: 0, distanceIn: 1.5 * M, offsetIn: 1 })))!;
    expect(maxU(typical)).toBeGreaterThan(0.7);
    expect(maxU(typical)).toBeLessThan(1.6);
  });

  it('grows with the angle off square and with the distance', () => {
    const at = (yawDeg: number, metres: number) => maxU(sizeFromCard(inputOf(photo({ winW: 36, winH: 60, yawDeg, pitchDeg: 2, distanceIn: metres * M, offsetIn: 1, exact: true })))!);
    expect(at(0, 2)).toBeLessThan(at(30, 2));
    expect(at(30, 2)).toBeLessThan(at(55, 2));
    expect(at(15, 1)).toBeLessThan(at(15, 2));
    expect(at(15, 2)).toBeLessThan(at(15, 3));
  });

  it("is 'check' exactly when the larger ± is above 3/8 in, with a reason, and 'good' with none otherwise", () => {
    const small = photo({ winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1 });
    const big = photo({ winW: 72, winH: 80, yawDeg: 10, distanceIn: 1.5 * M, offsetIn: 1 });
    const good = sizeFromCard(inputOf(small))!;
    expect(maxU(good)).toBeLessThanOrEqual(CARD_CHECK_UNCERTAINTY_IN);
    expect(good.quality).toBe('good');
    expect(good.reasons).toEqual([]);
    const check = sizeFromCard(inputOf(big))!;
    expect(maxU(check)).toBeGreaterThan(CARD_CHECK_UNCERTAINTY_IN);
    expect(check.quality).toBe('check');
    expect(check.reasons.length).toBeGreaterThan(0);
    // The line sits at 3/8, not above or below it: find the tap noise that makes the larger ± exactly 3/8.
    const mid = photo({ winW: 24, winH: 36, yawDeg: 10, distanceIn: 1.5 * M, offsetIn: 1 });
    const withTap = (tapSigmaPx: number) => sizeFromCard(inputOf(mid, { tapSigmaPx }))!;
    let lo = 0;
    let hi = 50;
    expect(maxU(withTap(lo))).toBeLessThan(CARD_CHECK_UNCERTAINTY_IN);
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      if (maxU(withTap(m)) <= CARD_CHECK_UNCERTAINTY_IN) lo = m;
      else hi = m;
    }
    expect(maxU(withTap(lo))).toBeCloseTo(CARD_CHECK_UNCERTAINTY_IN, 9);
    expect(withTap(lo).quality).toBe('good');
    expect(withTap(lo).reasons).toEqual([]);
    expect(withTap(hi).quality).toBe('check');
    expect(withTap(hi).reasons.length).toBeGreaterThan(0);
  });

  it('writes the ± in eighths of an inch, in plain words', () => {
    const r = sizeFromCard(inputOf(photo({ winW: 48, winH: 72, yawDeg: 10, distanceIn: 1.5 * M, offsetIn: 1 })))!;
    const reason = r.reasons[0]!;
    expect(reason).toMatch(/The card is small next to this window, so the size could be off by about (\d+ )?(\d\/\d|\d+) inch(es)?\./);
    expect(reason).toContain('Hold the card flat in the middle of the glass and step a little closer.');
    expect(reason).not.toContain('±');
    expect(inchesInWords(0.375)).toBe('3/8 inch');
    expect(inchesInWords(0.4)).toBe('1/2 inch');
    expect(inchesInWords(0.7)).toBe('3/4 inch');
    expect(inchesInWords(1)).toBe('1 inch');
    expect(inchesInWords(1.01)).toBe('1 1/8 inches');
    expect(inchesInWords(1.2)).toBe('1 1/4 inches');
    expect(inchesInWords(2)).toBe('2 inches');
    expect(inchesInWords(4.2)).toBe('5 inches');
    // Rounded UP: never understates.
    expect(reason).toContain(`about ${inchesInWords(maxU(r))}`);
  });

  it("a view steeper than 50 degrees is 'check' with its own reason, even for a window the ± would pass", () => {
    const steep = sizeFromCard(inputOf(photo({ winW: 6, winH: 9, yawDeg: 58, distanceIn: 1.2 * M, offsetIn: 1 }), { tapSigmaPx: 0.2 }))!;
    expect(steep.viewAngleDeg).toBeGreaterThan(STEEP_CHECK_DEG);
    expect(maxU(steep)).toBeLessThan(CARD_CHECK_UNCERTAINTY_IN);
    expect(steep.quality).toBe('check');
    expect(steep.reasons).toHaveLength(1);
    expect(steep.reasons[0]).toContain('well off to one side');
    const square = sizeFromCard(inputOf(photo({ winW: 6, winH: 9, yawDeg: 20, distanceIn: 1.2 * M, offsetIn: 1 }), { tapSigmaPx: 0.2 }))!;
    expect(square.quality).toBe('good');
    expect(square.reasons).toEqual([]);
  });

  it("a card that is small in the photo is 'check'", () => {
    const far = photo({ winW: 12, winH: 18, yawDeg: 10, distanceIn: 5.5 * M, offsetIn: 1, exact: true });
    const long = Math.max(...[0, 1, 2, 3].map((i) => Math.hypot(far.cardQuad[i]![0] - far.cardQuad[(i + 1) % 4]![0], far.cardQuad[i]![1] - far.cardQuad[(i + 1) % 4]![1])));
    expect(long).toBeLessThan(CARD_MIN_LONG_SIDE_FRAC * far.heightPx);
    const r = sizeFromCard(inputOf(far, { tapSigmaPx: 0.1 }))!;
    expect(r.quality).toBe('check');
    expect(r.reasons.join(' ')).toContain('The card looks small in the photo.');
  });

  it("a wide-angle lens is 'check', and so is a card that does not look like a card on the glass", () => {
    const wide = photo({ winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1, focal35: 13 });
    expect(sizeFromCard(inputOf(wide, { tapSigmaPx: 0.2 }))!.reasons.join(' ')).toContain('wide lens');
    const odd = photo({ winW: 12, winH: 18, yawDeg: 10, distanceIn: 1.2 * M, offsetIn: 1 }, { rectScale: [1, 1.6] });
    const r = sizeFromCard(inputOf(odd, { tapSigmaPx: 0.2 }))!;
    expect(r.quality).toBe('check');
    expect(r.reasons.join(' ')).toContain('do not look like a credit card');
  });

  it("a window that is very small in the photo is 'check'", () => {
    const far = photo({ winW: 24, winH: 36, yawDeg: 10, distanceIn: 100 * 39.37, offsetIn: 1, exact: true });
    const side = Math.hypot(far.windowQuad[1][0] - far.windowQuad[0][0], far.windowQuad[1][1] - far.windowQuad[0][1]);
    expect(side).toBeLessThan(20);
    const r = sizeFromCard(inputOf(far, { tapSigmaPx: 0.01 }))!;
    expect(r.quality).toBe('check');
    expect(r.reasons.join(' ')).toContain('The window is very small in this photo.');
  });
});

describe('what cannot be sized', () => {
  const good = photo({ winW: 36, winH: 60, yawDeg: 15, distanceIn: 1.5 * M, offsetIn: 1 });
  const base = inputOf(good);
  const pt = (q: Quad, i: number, p: Pt): Quad => q.map((v, k) => (k === i ? p : v)) as Quad;

  it('accepts a good capture', () => {
    expect(cardProblem({ ...base, card: { widthMm: 85.6, heightMm: 53.98 } })).toBeNull();
    expect(sizeFromCard(base)).not.toBeNull();
  });

  it('collinear card corners', () => {
    const c = good.cardQuad;
    const line: Quad = [c[0], [c[0][0] + 40, c[0][1] + 10], [c[0][0] + 80, c[0][1] + 20], [c[0][0] + 120, c[0][1] + 30]];
    expect(sizeFromCard({ ...base, cardCorners: line })).toBeNull();
    expect(cardProblem({ ...base, cardCorners: line })).toContain('do not make the shape of a card');
    // Three in a line.
    const three: Quad = [c[0], [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2], c[1], c[2]];
    expect(sizeFromCard({ ...base, cardCorners: three })).toBeNull();
    expect(cardProblem({ ...base, cardCorners: three })).not.toBeNull();
  });

  it('card corners that cross', () => {
    const c = good.cardQuad;
    const bowtie: Quad = [c[0], c[2], c[1], c[3]];
    expect(sizeFromCard({ ...base, cardCorners: bowtie })).toBeNull();
    expect(cardProblem({ ...base, cardCorners: bowtie })).toContain('cross over each other');
  });

  it('window corners that cross, or that are in a line', () => {
    const w = good.windowQuad;
    const bowtie: Quad = [w[0], w[2], w[1], w[3]];
    expect(sizeFromCard({ ...base, windowCorners: bowtie })).toBeNull();
    expect(cardProblem({ ...base, windowCorners: bowtie })).toContain('Mark them in order: top left, top right, bottom right, bottom left');
    const line: Quad = [w[0], [w[0][0] + 100, w[0][1] + 50], [w[0][0] + 200, w[0][1] + 100], [w[0][0] + 300, w[0][1] + 150]];
    expect(sizeFromCard({ ...base, windowCorners: line })).toBeNull();
    expect(cardProblem({ ...base, windowCorners: line })).toContain('do not make the shape of a window');
    // A dart (one corner pushed in past the diagonal) is no rectangle's picture either.
    const dart: Quad = [w[0], w[1], [w[0][0] + 0.4 * (w[2][0] - w[0][0]), w[0][1] + 0.4 * (w[2][1] - w[0][1])], w[3]];
    expect(sizeFromCard({ ...base, windowCorners: dart })).toBeNull();
    expect(cardProblem({ ...base, windowCorners: dart })).toContain('do not make the shape of a window');
  });

  it('a tiny card is refused with a reason; a small one is only flagged', () => {
    const c = good.cardQuad;
    const mid: Pt = [(c[0][0] + c[2][0]) / 2, (c[0][1] + c[2][1]) / 2];
    const shrink = (k: number): Quad => c.map((p) => [mid[0] + (p[0] - mid[0]) * k, mid[1] + (p[1] - mid[1]) * k] as Pt) as Quad;
    const tiny = shrink(0.15);
    expect(Math.max(...tiny.map((p, i) => Math.hypot(p[0] - tiny[(i + 1) % 4]![0], p[1] - tiny[(i + 1) % 4]![1])))).toBeLessThan(30);
    expect(cardProblem({ ...base, cardCorners: tiny })).toContain('too small in this photo');
    expect(cardProblem({ ...base, cardCorners: shrink(0.5) })).toBeNull();
  });

  it('a card bigger than the window (the two sets of corners swapped)', () => {
    expect(cardProblem({ ...base, cardCorners: good.windowQuad, windowCorners: good.cardQuad })).toContain('bigger than the window');
  });

  it('a card that is not the ID-1 size (a 60 x 40 mm "card", a 3 1/2 inch business card)', () => {
    expect(cardProblem({ ...base, card: { widthMm: 60, heightMm: 40 } })).toContain('3 3/8 by 2 1/8 inches');
    expect(cardProblem({ ...base, card: { widthMm: 88.9, heightMm: 50.8 } })).not.toBeNull();
    expect(cardProblem({ ...base, card: { widthMm: 85.7, heightMm: 53.98 } })).not.toBeNull();
    // Within 0.05 mm is the same card, whichever way round it is given.
    expect(cardProblem({ ...base, card: { widthMm: 85.64, heightMm: 53.96 } })).toBeNull();
    expect(cardProblem({ ...base, card: { widthMm: 53.98, heightMm: 85.6 } })).toBeNull();
  });

  it('points outside the photo, or not numbers', () => {
    const { widthPx, heightPx } = base;
    expect(cardProblem({ ...base, cardCorners: pt(good.cardQuad, 2, [widthPx + 40, 100]) })).toContain('card corners are outside the photo');
    expect(cardProblem({ ...base, windowCorners: pt(good.windowQuad, 0, [-30, 50]) })).toContain('window corners are outside the photo');
    expect(cardProblem({ ...base, windowCorners: pt(good.windowQuad, 3, [100, heightPx + 5]) })).toContain('window corners are outside the photo');
    expect(cardProblem({ ...base, cardCorners: pt(good.cardQuad, 1, [Number.NaN, 5]) })).toContain('outside the photo');
    expect(cardProblem({ ...base, widthPx: 0 })).toContain('could not be read');
    expect(sizeFromCard({ ...base, cardCorners: pt(good.cardQuad, 1, [Number.NaN, 5]) })).toBeNull();
    expect(sizeFromCard({ ...base, windowCorners: pt(good.windowQuad, 1, [Number.POSITIVE_INFINITY, 5]) })).toBeNull();
    expect(sizeFromCard({ ...base, focalPx: 0 })).toBeNull();
    expect(sizeFromCard({ ...base, widthPx: Number.NaN })).toBeNull();
    expect(sizeFromCard({ ...base, tapSigmaPx: -1 })).toBeNull();
    expect(sizeFromCard({ ...base, planeOffsetIn: Number.NaN })).toBeNull();
    expect(sizeFromCard({ ...base, planeOffsetIn: 9 })).toBeNull();
  });

  it('rays that miss the plane in front of the camera, and sizes that are not a window', () => {
    // A card off to the side of a steep view, past the vanishing line of the wall.
    const steep = photo({ winW: 36, winH: 60, yawDeg: 62, distanceIn: 2 * M, offsetIn: 1 });
    const left = steep.cardQuad.map(([x, y]) => [x - steep.widthPx * 0.9, y] as Pt) as Quad;
    expect(sizeFromCard(inputOf(steep, { cardCorners: left }))).toBeNull();
    // A frame in front of the camera's own plane (the frame offset larger than the distance).
    expect(sizeFromCard({ ...base, planeOffsetIn: 5.9 })).not.toBeNull();
    const close = photo({ winW: 36, winH: 60, yawDeg: 0, distanceIn: 4, offsetIn: 1, exact: true });
    expect(sizeFromCard(inputOf(close, { planeOffsetIn: 5 }))).toBeNull();
    // Too small and too big to be a window (3 to 400 in).
    expect(sizeFromCard(inputOf(photo({ winW: 2, winH: 2.5, yawDeg: 0, distanceIn: 1 * M, offsetIn: 1, exact: true })))).toBeNull();
    expect(sizeFromCard(inputOf(photo({ winW: 450, winH: 420, yawDeg: 0, distanceIn: 15 * M, offsetIn: 1, exact: true })))).toBeNull();
  });
});

describe('what the caller passes', () => {
  it('uses the default offset of 1 in, the 35 mm focal length it is given, and reads the photo as displayed', () => {
    const p = photo({ winW: 36, winH: 60, yawDeg: 15, distanceIn: 1.5 * M, offsetIn: 1 });
    const same = sizeFromCard(inputOf(p, { planeOffsetIn: CARD_DEFAULT_OFFSET_IN }))!;
    const dflt = sizeFromCard(inputOf(p))!;
    expect(dflt.widthIn).toBe(same.widthIn);
    // A photo that says nothing about its lens is sized with 26 mm.
    expect(p.focalPx).toBeCloseTo(focalPxFrom35mm(DEFAULT_FOCAL_35MM, p.widthPx, p.heightPx), 6);
    // Turn the photo 90 degrees (the corners keep their names: the window's top-left is still its top-left): same answer.
    const turn = (q: Quad): Quad => q.map(([x, y]) => [p.heightPx - y, x] as Pt) as Quad;
    const turned = sizeFromCard({ widthPx: p.heightPx, heightPx: p.widthPx, focalPx: p.focalPx, cardCorners: turn(p.cardQuad), windowCorners: turn(p.windowQuad) })!;
    expect(turned.widthIn).toBeCloseTo(dflt.widthIn, 6);
    expect(turned.heightIn).toBeCloseTo(dflt.heightIn, 6);
  });
});
