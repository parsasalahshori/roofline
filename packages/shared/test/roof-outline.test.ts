// Outline track: squaring a rasterised footprint. Synthetic footprints (L, T, U, cross-gable, two-axis) are drawn as
// pixel masks at many angles with ragged edges, traced and squared; the squared edges are compared with the truth.
import { describe, expect, it } from 'vitest';
import { dist, type XY } from '../src/roof-reconstruct/geom.ts';
import { maskBoundary, squareOutline } from '../src/roof-reconstruct/outline.ts';
import { close, fillHoles, largestComponent, open3, seededRandom } from '../src/roof-reconstruct/raster.ts';

type Poly = XY[];
const deg = Math.PI / 180;

function inPoly(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function turn(poly: Poly, a: number, c: XY = { x: 0, y: 0 }): Poly {
  return poly.map((p) => ({ x: c.x + (p.x - c.x) * Math.cos(a) - (p.y - c.y) * Math.sin(a), y: c.y + (p.x - c.x) * Math.sin(a) + (p.y - c.y) * Math.cos(a) }));
}

/**
 * A pixel mask of the union of `polys` (metres, x east, y north) at pixel size s, with ragged edges: each pixel within
 * `ragM` of the boundary is flipped with probability 0.3 (seeded). Pixel (r, c) has its centre at ((c + 0.5) s, -(r + 0.5) s)
 * after the polygons are moved to sit inside the grid with a margin.
 */
function rasterise(polys: Poly[], s: number, ragM: number, seed: number) {
  const all = polys.flat();
  const minX = Math.min(...all.map((p) => p.x)) - 3;
  const maxY = Math.max(...all.map((p) => p.y)) + 3;
  const w = Math.ceil((Math.max(...all.map((p) => p.x)) + 3 - minX) / s);
  const h = Math.ceil((maxY - Math.min(...all.map((p) => p.y)) + 3) / s);
  const moved = polys.map((poly) => poly.map((p) => ({ x: p.x - minX, y: p.y - maxY })));
  const m = new Uint8Array(w * h);
  const rng = seededRandom(seed);
  const edgeDist = (p: XY) => {
    let best = Infinity;
    for (const poly of moved) {
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k]!;
        const b = poly[(k + 1) % poly.length]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
      }
    }
    return best;
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const p = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
      let v = moved.some((poly) => inPoly(p, poly)) ? 1 : 0;
      if (ragM > 0 && edgeDist(p) < ragM && rng() < 0.3) v = 1 - v;
      m[r * w + c] = v;
    }
  }
  return { g: { w, h }, m, truth: moved };
}

/** The mask cleaned the way the reconstruction cleans it before tracing (close 0.3 m, open, largest part, holes filled). */
function clean(g: { w: number; h: number }, m: Uint8Array): Uint8Array {
  return fillHoles(g, largestComponent(g, open3(g, fillHoles(g, close(g, m, 3)))));
}

function hausdorff(a: readonly XY[], b: readonly XY[]): number {
  const d = (p: XY, ring: readonly XY[]) => {
    let best = Infinity;
    for (let k = 0; k < ring.length; k++) {
      const u = ring[k]!;
      const v = ring[(k + 1) % ring.length]!;
      const dx = v.x - u.x;
      const dy = v.y - u.y;
      const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy));
    }
    return best;
  };
  return Math.max(...a.map((p) => d(p, b)), ...b.map((p) => d(p, a)));
}
const ringArea = (r: readonly XY[]) => r.reduce((t, p, i) => t + p.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * p.y, 0) / 2;

/** Each edge of `ring` at least minLen long: its angle error (degrees, mod 180) against the nearest truth edge. */
function edgeAngleErrors(ring: readonly XY[], truth: readonly Poly[], minLen: number): number[] {
  const tEdges = truth.flatMap((poly) => poly.map((a, k) => ({ a, b: poly[(k + 1) % poly.length]! })));
  const out: number[] = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!;
    const b = ring[(k + 1) % ring.length]!;
    if (dist(a, b) < minLen) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let best = Infinity;
    let bestAng = 0;
    for (const e of tEdges) {
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const t = Math.max(0, Math.min(1, ((mid.x - e.a.x) * dx + (mid.y - e.a.y) * dy) / (dx * dx + dy * dy)));
      const d = Math.hypot(mid.x - e.a.x - t * dx, mid.y - e.a.y - t * dy);
      if (d < best) {
        best = d;
        bestAng = Math.atan2(dy, dx);
      }
    }
    let diff = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) - bestAng) % Math.PI;
    diff = Math.min(diff, Math.PI - diff);
    out.push(diff / deg);
  }
  return out;
}

const L_SHAPE: Poly = [{ x: 0, y: 0 }, { x: 14, y: 0 }, { x: 14, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 12 }, { x: 0, y: 12 }];
const T_SHAPE: Poly = [{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 6 }, { x: 11, y: 6 }, { x: 11, y: 13 }, { x: 5, y: 13 }, { x: 5, y: 6 }, { x: 0, y: 6 }];
const U_SHAPE: Poly = [{ x: 0, y: 0 }, { x: 18, y: 0 }, { x: 18, y: 12 }, { x: 13, y: 12 }, { x: 13, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 12 }, { x: 0, y: 12 }];
const CROSS: Poly = [
  { x: 5, y: 0 }, { x: 11, y: 0 }, { x: 11, y: 5 }, { x: 17, y: 5 }, { x: 17, y: 11 }, { x: 11, y: 11 },
  { x: 11, y: 16 }, { x: 5, y: 16 }, { x: 5, y: 11 }, { x: 0, y: 11 }, { x: 0, y: 5 }, { x: 5, y: 5 },
];

describe('outline squaring on rasterised footprints', () => {
  it('keeps every long edge of L, T, U and cross footprints within 2 degrees at any angle, with ragged edges', () => {
    const worst: string[] = [];
    for (const [name, shape] of [['L', L_SHAPE], ['T', T_SHAPE], ['U', U_SHAPE], ['cross', CROSS]] as const) {
      for (let a = 3; a < 90; a += 11) {
        const { g, m, truth } = rasterise([turn(shape, a * deg)], 0.1, 0.15, a);
        const ring = squareOutline(maskBoundary(g, clean(g, m), 0.1));
        const errs = edgeAngleErrors(ring, truth, 2);
        const max = Math.max(...errs);
        if (max > 2) worst.push(`${name}@${a}: ${max.toFixed(1)}`);
      }
    }
    expect(worst).toEqual([]);
  });

  it('squares each wing of a two-axis house to its own direction', () => {
    const worst: string[] = [];
    for (const [a, b] of [[10, 40], [5, 30], [20, 65], [0, 25]] as const) {
      // A 16 x 8 m wing and a 10 x 7 m wing turned b - a degrees against it, overlapping at the corner.
      const w1 = turn([{ x: 0, y: 0 }, { x: 16, y: 0 }, { x: 16, y: 8 }, { x: 0, y: 8 }], a * deg);
      const w2 = turn([{ x: 12, y: 2 }, { x: 22, y: 2 }, { x: 22, y: 9 }, { x: 12, y: 9 }], b * deg, turn([{ x: 14, y: 4 }], a * deg)[0]!);
      const { g, m, truth } = rasterise([w1, w2], 0.1, 0.15, a + b);
      const ring = squareOutline(maskBoundary(g, clean(g, m), 0.1));
      const errs = edgeAngleErrors(ring, truth, 2.5);
      // Edges of the turned wing are more than the snap angle off the main axis, so they are left free and refitted to
      // their boundary: within 4.5 degrees (snapping them to a second, estimated axis did not do better: see
      // docs/roof-3d/outline.md).
      const max = Math.max(...errs);
      if (max > 4.5) worst.push(`${a}/${b}: ${max.toFixed(1)} (${errs.map((e) => e.toFixed(0)).join(',')})`);
    }
    expect(worst).toEqual([]);
  });
});

describe('outline metamorphic properties', () => {
  const sq = (ring: readonly XY[]) => ring.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`);
  it('turning the mask a quarter turn turns the outline a quarter turn', () => {
    for (const a0 of [8, 23, 52]) {
      const { g, m } = rasterise([turn(T_SHAPE, a0 * deg)], 0.1, 0.15, a0);
      const mm = clean(g, m);
      // The pixel grid turned 90 degrees clockwise: new (r, c) = (c, h - 1 - r); lattice point (x, y) -> (h s + y, -x).
      const g2 = { w: g.h, h: g.w };
      const m2 = new Uint8Array(mm.length);
      for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) m2[c * g2.w + (g.h - 1 - r)] = mm[r * g.w + c]!;
      const a = squareOutline(maskBoundary(g, mm, 0.1)).map((p) => ({ x: g.h * 0.1 + p.y, y: -p.x }));
      const b = squareOutline(maskBoundary(g2, m2, 0.1));
      // The simplification starts at another boundary point, so equal within its tolerance (0.3 m), not to the bit.
      expect(hausdorff(a, b)).toBeLessThan(0.3);
      expect(Math.abs(ringArea(a) - ringArea(b))).toBeLessThan(0.005 * ringArea(a));
    }
  });

  it('doubling the pixel size doubles the outline', () => {
    const { g, m } = rasterise([turn(U_SHAPE, 31 * deg)], 0.1, 0.15, 6);
    const mm = clean(g, m);
    const a = squareOutline(maskBoundary(g, mm, 0.1)).map((p) => ({ x: 2 * p.x, y: 2 * p.y }));
    // The same pixels at 0.2 m with every length parameter doubled (the axis search's own steps stay in metres).
    const b = squareOutline(maskBoundary(g, mm, 0.2), { simplifyM: 0.6, snapDeg: 12, mergeOffsetM: 0.6, minEdgeM: 0.5, chamferM: 3, zigzagM: 6, zigzagOffM: 1.4 });
    expect(hausdorff(a, b)).toBeLessThan(0.3);
    expect(Math.abs(ringArea(a) - ringArea(b))).toBeLessThan(0.01 * ringArea(a));
  });

  it('is deterministic', () => {
    const { g, m } = rasterise([turn(CROSS, 41 * deg)], 0.1, 0.15, 7);
    const mm = clean(g, m);
    expect(sq(squareOutline(maskBoundary(g, mm, 0.1)))).toEqual(sq(squareOutline(maskBoundary(g, mm, 0.1))));
  });
});
