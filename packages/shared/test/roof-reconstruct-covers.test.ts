import { describe, expect, it } from 'vitest';
import { type CoverParams, cutCovers, DEFAULT_COVER_PARAMS, judgeCovers } from '../src/roof-reconstruct/covers.ts';
import { signedArea } from '../src/roof-reconstruct/geom.ts';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import type { Plane } from '../src/roof-reconstruct/planes.ts';
import { type Shape, synthesize } from './fixtures/synthetic-roofs.ts';

// Pieces of the mask that are not roof (covers.ts): a deck or terrace a storey under the house with things standing on
// it, a see-through pergola. A flat roof section (continuous with the roof) or a smooth porch roof stays.

const ON: Partial<CoverParams> = { enabled: true };

/** Things standing on a deck (a table, a grill, a planter): 1 m boxes 0.8 m tall, house frame. */
const FURNITURE = [
  { x: -2.5, y: -6.2 },
  { x: 0, y: -6.6 },
  { x: 2.5, y: -6.2 },
];
const onFurniture = (x: number, y: number) => FURNITURE.some((f) => Math.abs(x - f.x) <= 0.5 && Math.abs(y - f.y) <= 0.5);

/** A two-storey gable 12 x 8 m at 6/12 (eaves 6 m up) with an 8 x 4 m flat piece 2.6 m up along its south side. */
function withFlatSouth(name: string, topM: number, things: boolean, eaveM = 6): Shape {
  return {
    name,
    extent: 10,
    height: ({ x, y }) => {
      if (Math.abs(x) <= 6 && Math.abs(y) <= 4) return eaveM + (4 - Math.abs(y)) * 0.5;
      if (Math.abs(x) <= 4 && y < -4 && y >= -8) return things && onFurniture(x, y) ? topM + 0.8 : topM;
      return null;
    },
    faces: [],
    lines: {},
    planAreaM2: 96 + 32,
  };
}

const area = (r: { outline: { x: number; y: number }[] }) => Math.abs(signedArea(r.outline));
const flatFaces = (r: { faces: { pitchX12: number }[] }) => r.faces.filter((f) => f.pitchX12 < 2.5).length;

describe('reconstructRoof: a deck is cut out of the roof, a roof section is not', () => {
  it('cuts a deck a storey under the house with things standing on it: outline, faces and lines without it', () => {
    const syn = synthesize(withFlatSouth('deck', 2.6, true), { trees: 0 });
    const off = reconstructRoof(syn.raster, syn.point)!;
    const on = reconstructRoof(syn.raster, syn.point, { covers: ON })!;
    expect(off.covers).toBeUndefined();
    expect(on.covers).toBeDefined();
    expect(on.covers!.every((p) => p.kind === 'deck')).toBe(true);
    // 32 m2 of deck out of the outline; the house's 96 m2 stay.
    expect(area(off) - area(on)).toBeGreaterThan(26);
    expect(area(off) - area(on)).toBeLessThan(38);
    expect(area(on)).toBeGreaterThan(90);
    expect(flatFaces(off)).toBeGreaterThan(0);
    expect(flatFaces(on)).toBe(0);
    // The faces still tile the outline.
    expect(on.faces.reduce((t, f) => t + f.planAreaM2, 0)).toBeCloseTo(area(on), 6);
    expect(on.lines.filter((l) => l.kind === 'flat-edge')).toHaveLength(0);
  });

  it('keeps the same piece when it is smooth (a porch roof under an upper storey) and when the cut is off', () => {
    const syn = synthesize(withFlatSouth('porch roof', 2.6, false), { trees: 0 });
    const on = reconstructRoof(syn.raster, syn.point, { covers: ON })!;
    const off = reconstructRoof(syn.raster, syn.point)!;
    expect(on.covers).toBeUndefined();
    expect(area(on)).toBeCloseTo(area(off), 6);
    expect(flatFaces(on)).toBeGreaterThan(0);
  });

  it('keeps a flat section at the eaves of the roof it adjoins, even with things standing on it (units on a flat roof)', () => {
    const syn = synthesize(withFlatSouth('flat section', 3, true, 3), { trees: 0 });
    const on = reconstructRoof(syn.raster, syn.point, { covers: ON })!;
    const off = reconstructRoof(syn.raster, syn.point)!;
    expect(on.covers).toBeUndefined();
    expect(area(on)).toBeCloseTo(area(off), 6);
  });
});

describe('judgeCovers: a pergola is seen through, a ramp is not', () => {
  // A 10 x 10 m grid at 0.1 m: a 6/12 face (label 0, rows 5-64) 6 m and more up, and a flat piece (label 1, rows
  // 65-94) 3 m up at the roof's south edge; the ground is at 0.
  const g = { w: 100, h: 100 };
  const s = 0.1;
  const roof = new Uint8Array(g.w * g.h);
  const labels = new Int32Array(g.w * g.h).fill(-1);
  for (let r = 5; r < 95; r++) {
    for (let c = 10; c < 90; c++) {
      roof[r * g.w + c] = 1;
      labels[r * g.w + c] = r < 65 ? 0 : 1;
    }
  }
  // Face 0 rises to the north from 6 m at its south edge (y = -6.5).
  const planes: Plane[] = [
    { a: 0, b: 0.5, c: 6 + 0.5 * 6.5 },
    { a: 0, b: 0, c: 3 },
  ];
  const dsmOf = (hole: (r: number, c: number) => boolean) => {
    const dsm = new Float32Array(g.w * g.h);
    for (let i = 0; i < dsm.length; i++) {
      const c = i % g.w;
      const r = (i - c) / g.w;
      if (labels[i] === 0) dsm[i] = planes[0]!.c + planes[0]!.b * -(r + 0.5) * s;
      else if (labels[i] === 1) dsm[i] = hole(r, c) ? 0.2 : 3;
    }
    return dsm;
  };
  const prm: CoverParams = { ...DEFAULT_COVER_PARAMS, enabled: true, pergola: true };
  const piece = (dsm: Float32Array, p = prm) => judgeCovers(g, s, dsm, roof, labels, planes, dsm, p).find((q) => q.faces.includes(1))!;

  it('calls a flat piece whose heights reach the ground between slats a pergola, only when asked', () => {
    // Slats 0.3 m wide with 0.2 m gaps, running east-west.
    const slats = dsmOf((r) => r % 5 >= 3);
    expect(piece(slats).seeThroughShare).toBeGreaterThan(0.15);
    expect(piece(slats).kind).toBe('pergola');
    expect(piece(slats, { ...prm, pergola: false }).kind).toBeNull();
  });

  it('does not call a piece whose low heights are one block (a ramp, a hole) a pergola', () => {
    const block = dsmOf((r, c) => r >= 80 && c >= 40 && c < 80);
    expect(piece(block).seeThroughShare).toBe(0);
    expect(piece(block).kind).toBeNull();
  });
});

describe('cutCovers: what the cut leaves hanging off the house goes with it', () => {
  it('drops a piece joined to the house by a narrow neck next to the cut, and keeps one far from it', () => {
    const g = { w: 100, h: 100 };
    const roof = new Uint8Array(g.w * g.h);
    const cut = new Uint8Array(g.w * g.h);
    const set = (r0: number, r1: number, c0: number, c1: number, m: Uint8Array) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m[r * g.w + c] = 1;
    };
    set(20, 59, 10, 69, roof); // the house
    set(60, 69, 10, 69, roof); // a deck along its south side, cut
    set(60, 69, 10, 69, cut);
    set(60, 69, 70, 70, roof); // a 0.1 m neck round the deck's east end
    set(70, 79, 50, 70, roof); // the rest of the terrace, beyond the deck
    set(5, 14, 30, 39, roof); // a piece on the north side, joined by its own neck, far from the cut
    set(15, 19, 35, 35, roof);
    const out = cutCovers(g, 0.1, roof, cut);
    expect(out[65 * g.w + 30]).toBe(0);
    expect(out[75 * g.w + 60]).toBe(0);
    expect(out[40 * g.w + 40]).toBe(1);
    expect(out[10 * g.w + 35]).toBe(1);
  });
});
