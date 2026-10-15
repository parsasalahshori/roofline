// The canopy track (roof-reconstruct/canopy.ts): the crown map, and roof completion under crowns and in shade, on
// synthetic height maps with exact truth. Hermetic: no files, no network, seeded noise only.
import { describe, expect, it } from 'vitest';
import { completeRoof, crownMap, DEFAULT_CANOPY_PARAMS, localPlaneRms } from '../src/roof-reconstruct/canopy.ts';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';

type XY = { x: number; y: number };

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, r()))) * Math.cos(2 * Math.PI * r());
}

/**
 * A scene on a 0.1 m grid, `size` metres square: flat ground at 0, a gable (ridge along the house's x axis, turned by
 * `turnDeg`) of half-length `hx` and half-depth `hy` at 6/12, eaves 3 m up, a 3 x 3 box blur (an eave is a short
 * ramp, as in a height map), `noise` metres of Gaussian noise; optional crowns (paraboloids `crownUp` metres above
 * the eave at their middle) at house-frame points. `inMask(p)` says which roof points Google's mask has.
 */
function scene(o: {
  seed: number;
  turnDeg: number;
  hx?: number;
  hy?: number;
  size?: number;
  noise?: number;
  crowns?: { at: XY; r: number }[];
  inMask?: (p: XY) => boolean;
  /** Replaces the ground's height at a house-frame point (a height map's interpolation in shadow). */
  ground?: (p: XY) => number;
}) {
  const s = 0.1;
  const size = o.size ?? 30;
  const W = Math.round(size / s);
  const hx = o.hx ?? 7;
  const hy = o.hy ?? 4.5;
  const t = (o.turnDeg * Math.PI) / 180;
  const cx = size / 2;
  const cy = -size / 2;
  const toHouse = (p: XY): XY => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: dx * Math.cos(t) + dy * Math.sin(t), y: -dx * Math.sin(t) + dy * Math.cos(t) };
  };
  const toLocal = (p: XY): XY => ({ x: cx + p.x * Math.cos(t) - p.y * Math.sin(t), y: cy + p.x * Math.sin(t) + p.y * Math.cos(t) });
  const roofZ = (q: XY) => (Math.abs(q.x) <= hx && Math.abs(q.y) <= hy ? 3 + (hy - Math.abs(q.y)) * 0.5 : null);
  const clean = new Float32Array(W * W);
  const truth = new Uint8Array(W * W);
  const mask = new Uint8Array(W * W);
  const crownTruth = new Uint8Array(W * W);
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < W; c++) {
      const q = toHouse({ x: (c + 0.5) * s, y: -(r + 0.5) * s });
      const z = roofZ(q);
      const i = r * W + c;
      clean[i] = z ?? (o.ground?.(q) ?? 0);
      if (z !== null) {
        truth[i] = 1;
        if (o.inMask?.(q) ?? true) mask[i] = 1;
      }
    }
  }
  const dsm = new Float32Array(W * W);
  const g = rng(o.seed);
  for (let r = 0; r < W; r++) {
    for (let c = 0; c < W; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= W || cc >= W) continue;
          sum += clean[rr * W + cc]!;
          n++;
        }
      }
      dsm[r * W + c] = sum / n + gauss(g) * (o.noise ?? 0.02);
    }
  }
  for (const cr of o.crowns ?? []) {
    const at = toLocal(cr.at);
    const top = 3 + hy * 0.5 + 2;
    for (let r = 0; r < W; r++) {
      for (let c = 0; c < W; c++) {
        const d = Math.hypot((c + 0.5) * s - at.x, -(r + 0.5) * s - at.y);
        if (d > cr.r) continue;
        // Foliage: a dome with 0.25 m of leafy roughness.
        const z = top - (d * d) / (cr.r * 1.5) + gauss(g) * 0.25;
        const i = r * W + c;
        if (z > dsm[i]!) {
          dsm[i] = z;
          if (z > 1.5) crownTruth[i] = 1;
        }
      }
    }
  }
  const box = [toLocal({ x: -hx, y: -hy }), toLocal({ x: hx, y: -hy }), toLocal({ x: hx, y: hy }), toLocal({ x: -hx, y: hy })];
  const bx = box.map((p) => p.x);
  const by = box.map((p) => p.y);
  // Google's box is north-up: the bounds of the building.
  const nbox = [
    { x: Math.min(...bx), y: Math.min(...by) },
    { x: Math.max(...bx), y: Math.min(...by) },
    { x: Math.max(...bx), y: Math.max(...by) },
    { x: Math.min(...bx), y: Math.max(...by) },
  ];
  return { s, W, g: { w: W, h: W }, dsm, mask, truth, crownTruth, box: nbox, turn: t, toLocal, hag: Float32Array.from(dsm) };
}

/** Labels for a gable mask: face 0 north (y > 0), 1 south; the planes in grid metres. */
function gableFaces(sc: ReturnType<typeof scene>) {
  const n = sc.W * sc.W;
  const labels = new Int32Array(n).fill(-1);
  const cx = (sc.W * sc.s) / 2;
  const cy = -(sc.W * sc.s) / 2;
  for (let i = 0; i < n; i++) {
    if (sc.mask[i] !== 1) continue;
    const x = ((i % sc.W) + 0.5) * sc.s - cx;
    const y = -(Math.floor(i / sc.W) + 0.5) * sc.s - cy;
    labels[i] = -x * Math.sin(sc.turn) + y * Math.cos(sc.turn) >= 0 ? 0 : 1;
  }
  // z = 3 + (hy - |v|) * 0.5 with v the house-frame y: v = -dx sin t + dy cos t.
  const plane = (sign: number) => {
    const a = -0.5 * sign * -Math.sin(sc.turn);
    const b = -0.5 * sign * Math.cos(sc.turn);
    // At the centre (v = 0) z = 3 + 4.5 * 0.5.
    return { a, b, c: 3 + 4.5 * 0.5 - a * cx - b * cy };
  };
  return { labels, planes: [plane(1), plane(-1)] };
}

const count = (m: Uint8Array, f: (i: number) => boolean = () => true) => {
  let k = 0;
  for (let i = 0; i < m.length; i++) if (m[i] && f(i)) k++;
  return k;
};

describe('localPlaneRms', () => {
  it('is near zero on a plane and large on foliage', () => {
    const g = { w: 40, h: 40 };
    const plane = new Float32Array(1600).map((_, i) => 100 + 0.5 * (i % 40) * 0.1 - 0.3 * Math.floor(i / 40) * 0.1);
    const r = localPlaneRms(g, plane, 4);
    expect(r[20 * 40 + 20]!).toBeLessThan(1e-4);
    expect(Number.isNaN(r[0]!)).toBe(true);
    const g2 = rng(3);
    const leafy = plane.map((z) => z + gauss(g2) * 0.2);
    expect(localPlaneRms(g, leafy, 4)[20 * 40 + 20]!).toBeGreaterThan(0.1);
  });
});

describe('crownMap', () => {
  // Property: across positions, sizes, turns and seeds, the geometric rule (no photo at all) finds crowns standing
  // beside the roof and never marks the planar roof or the ground.
  const cases: { seed: number; turn: number; at: XY; r: number }[] = [];
  for (const seed of [7, 8, 9]) for (const turn of [0, 23, 61]) for (const [at, r] of [[{ x: 0, y: 7.5 }, 2.5], [{ x: 9.5, y: 0 }, 3], [{ x: -6, y: -7 }, 2]] as const) cases.push({ seed, turn, at, r });
  it.each(cases)('seed $seed turn $turn crown at ($at.x, $at.y) r $r', ({ seed, turn, at, r }) => {
    const sc = scene({ seed, turnDeg: turn, crowns: [{ at, r }] });
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    const tp = count(crown, (i) => sc.crownTruth[i] === 1);
    const recall = tp / Math.max(1, count(sc.crownTruth, (i) => sc.mask[i] !== 1));
    const precision = tp / Math.max(1, count(crown));
    expect(recall).toBeGreaterThan(0.7);
    expect(precision).toBeGreaterThan(0.9);
    // Never on the roof.
    expect(count(crown, (i) => sc.mask[i] === 1)).toBe(0);
  });
  it('without heights above the ground there is no crown map', () => {
    const sc = scene({ seed: 7, turnDeg: 10, crowns: [{ at: { x: 0, y: 7 }, r: 2 }] });
    expect(count(crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, null))).toBe(0);
  });
  it('photo-green counts only above the ground (lawn is not a crown)', () => {
    const sc = scene({ seed: 7, turnDeg: 10 });
    const green = new Uint8Array(sc.W * sc.W).fill(1);
    // Off the roof and its blurred eave (the height map's ramp, 0.2 m wide here), green lawn is never crown.
    const near = new Uint8Array(sc.W * sc.W);
    for (let i = 0; i < near.length; i++) {
      if (sc.mask[i] !== 1) continue;
      for (let d = -3; d <= 3; d++) for (const j of [i + d, i + d * sc.W]) if (j >= 0 && j < near.length) near[j] = 1;
    }
    expect(count(crownMap(sc.g, sc.s, sc.dsm, sc.mask, green, sc.hag), (i) => near[i] !== 1)).toBe(0);
  });
});

describe('completeRoof', () => {
  const p = DEFAULT_CANOPY_PARAMS;
  // A wing of the roof the mask left out (a crown's shadow: the photo is dark there), the heights intact, its far eave
  // a real drop: grown, within the truth.
  const wing: { seed: number; turn: number; cut: number }[] = [];
  for (const seed of [7, 8, 9]) for (const turn of [0, 17, 40]) for (const cut of [2, 3.5]) wing.push({ seed, turn, cut });
  it.each(wing)('grows a wing left out of the mask (seed $seed turn $turn cut $cut m)', ({ seed, turn, cut }) => {
    const sc = scene({ seed, turnDeg: turn, inMask: (q) => q.x < 7 - cut });
    const { labels, planes } = gableFaces(sc);
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    const done = completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, crown, sc.box, sc.turn, p);
    expect(done).not.toBeNull();
    const missing = count(sc.truth, (i) => sc.mask[i] !== 1);
    const got = count(done!.added, (i) => sc.truth[i] === 1);
    const wrong = count(done!.added, (i) => sc.truth[i] !== 1);
    // The ridge's and eaves' blurred pixels (about a third of a narrow wing) are left to the outline.
    expect(got / missing).toBeGreaterThan(0.45);
    expect(wrong * sc.s * sc.s).toBeLessThan(0.1 * missing * sc.s * sc.s + 0.5);
    expect(done!.bridgedM2).toBe(0);
  });

  // In a roof's own shadow a height map is interpolated: on the roof's plane next to it, fading to the ground with no
  // eave drop. Not roof: nothing grows (the reason simple growing was reverted).
  it.each([7, 8, 9])('does not grow into interpolated shadow (seed %i)', (seed) => {
    const sc = scene({ seed, turnDeg: 25, ground: (q) => (q.y > 4.5 && q.y < 8 && Math.abs(q.x) < 7 ? Math.max(0, 3 - (q.y - 4.5) * 0.5 - ((q.y - 4.5) ** 2) * 0.2) : 0) });
    const { labels, planes } = gableFaces(sc);
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    const done = completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, crown, sc.box, sc.turn, p);
    expect(done?.grownM2 ?? 0).toBe(0);
  });

  // A crown overhanging the eave: Google's mask stops at the crown, leaving a notch in the roof line. Bridged along
  // the roof line, marked inferred, and not past the eave.
  const notch: { seed: number; turn: number; x: number; r: number }[] = [];
  for (const seed of [7, 8, 9]) for (const turn of [0, 30]) for (const [x, r] of [[0, 1.4], [-3, 1.1], [3.5, 1.3]] as const) notch.push({ seed, turn, x, r });
  it.each(notch)('bridges the notch a crown bites out of an eave (seed $seed turn $turn x $x r $r)', ({ seed, turn, x, r }) => {
    const crowns = [{ at: { x, y: 4.8 }, r }];
    const sc = scene({ seed, turnDeg: turn, crowns, inMask: (q) => Math.hypot(q.x - x, q.y - 4.8) > r });
    const { labels, planes } = gableFaces(sc);
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    const done = completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, crown, sc.box, sc.turn, p);
    expect(done).not.toBeNull();
    const missing = count(sc.truth, (i) => sc.mask[i] !== 1);
    const got = count(done!.added, (i) => sc.truth[i] === 1);
    const wrong = count(done!.added, (i) => sc.truth[i] !== 1);
    expect(got / missing).toBeGreaterThan(0.6);
    // Past the eave: at most a pixel row's worth along the notch.
    expect(wrong * sc.s * sc.s).toBeLessThan(0.25 * missing * sc.s * sc.s + 0.3);
    expect(done!.bridgedM2).toBeGreaterThan(0);
  });

  it('a notch wider than bridgeMaxM is left alone (it may be a real gap between two wings)', () => {
    const sc = scene({ seed: 7, turnDeg: 0, crowns: [{ at: { x: 0, y: 4.8 }, r: 2.6 }], inMask: (q) => Math.hypot(q.x, q.y - 4.8) > 2.6 });
    const { labels, planes } = gableFaces(sc);
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    const done = completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, crown, sc.box, sc.turn, p);
    const missing = count(sc.truth, (i) => sc.mask[i] !== 1);
    expect(count(done?.added ?? new Uint8Array(0), (i) => sc.truth[i] === 1) / missing).toBeLessThan(0.5);
  });

  it('a crown standing beside a straight eave (no notch) adds nothing', () => {
    const sc = scene({ seed: 7, turnDeg: 12, crowns: [{ at: { x: 0, y: 7.2 }, r: 2.4 }] });
    const { labels, planes } = gableFaces(sc);
    const crown = crownMap(sc.g, sc.s, sc.dsm, sc.mask, null, sc.hag);
    expect(completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, crown, sc.box, sc.turn, p)).toBeNull();
  });

  it('without Google\'s box nothing is completed', () => {
    const sc = scene({ seed: 7, turnDeg: 0, inMask: (q) => q.x < 4 });
    const { labels, planes } = gableFaces(sc);
    expect(completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, sc.mask, new Uint8Array(sc.W * sc.W), null, 0, p)).toBeNull();
  });

  it('never takes another mask part', () => {
    const sc = scene({ seed: 8, turnDeg: 0, inMask: (q) => q.x < 4 });
    const { labels, planes } = gableFaces(sc);
    const any = Uint8Array.from(sc.truth);
    const done = completeRoof(sc.g, sc.s, sc.dsm, sc.mask, labels, planes, any, new Uint8Array(sc.W * sc.W), sc.box, 0, p);
    expect(done).toBeNull();
  });
});

describe('reconstructRoof with completion', () => {
  const toPx = (sc: ReturnType<typeof scene>) => sc.box.map((q) => ({ col: q.x / sc.s, row: -q.y / sc.s }));
  it.each([7, 8, 9])('a wing left out of the mask comes back, with area nearer the truth (seed %i)', (seed) => {
    const sc = scene({ seed, turnDeg: 17, size: 34, inMask: (q) => q.x < 4 });
    const raster = { width: sc.W, height: sc.W, pixelSizeM: sc.s, dsm: sc.dsm, mask: sc.mask };
    const pt = { col: sc.W / 2 - 15, row: sc.W / 2 };
    const on = reconstructRoof(raster, pt, { seed, building: toPx(sc) });
    const off = reconstructRoof(raster, pt, { seed, building: toPx(sc), canopy: { complete: false } });
    const area = (r: typeof on) => r!.faces.reduce((t, f) => t + f.planAreaM2, 0);
    expect(on?.canopy?.grownM2 ?? 0).toBeGreaterThan(10);
    expect(Math.abs(area(on) - 126)).toBeLessThan(Math.abs(area(off) - 126));
    expect(Math.abs(area(on) - 126) / 126).toBeLessThan(0.1);
  });
  it('nothing to complete: byte-identical to completion off, and deterministic', () => {
    const sc = scene({ seed: 7, turnDeg: 17, size: 34 });
    const raster = { width: sc.W, height: sc.W, pixelSizeM: sc.s, dsm: sc.dsm, mask: sc.mask };
    const pt = { col: sc.W / 2, row: sc.W / 2 };
    const a = JSON.stringify(reconstructRoof(raster, pt, { building: toPx(sc) }));
    const b = JSON.stringify(reconstructRoof(raster, pt, { building: toPx(sc), canopy: { complete: false } }));
    expect(a).toBe(b);
    expect(JSON.stringify(reconstructRoof(raster, pt, { building: toPx(sc) }))).toBe(a);
  });
});
