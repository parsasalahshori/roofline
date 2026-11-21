import { describe, expect, it } from 'vitest';
import { DEFAULT_PITCH_PARAMS, type LocalRoof, type PitchFace, reconstructRoof, reportedPitches } from '../src/roof-reconstruct/index.ts';
import { weightedMedian } from '../src/roof-reconstruct/pitch.ts';
import { hipShape, PORCH, synthesize, TWO_STOREY, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

const OWN = { ...DEFAULT_PITCH_PARAMS, pool: false };
const face = (pitchX12: number, areaM2: number): PitchFace => ({ pitchX12, areaM2 });

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The whole pitch carrying the most sloped area, as a report gives a roof's predominant pitch. */
function mainPitch(roof: LocalRoof): number {
  const by = new Map<number, number>();
  for (const f of roof.faces) if (!f.flat) by.set(Math.round(f.pitchX12), (by.get(Math.round(f.pitchX12)) ?? 0) + f.slopedAreaM2);
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * The same roof on a height map that leans: `lean` metres of height per metre across the ridge (house frame +Y), the
 * way a photogrammetric surface leans away from the side it saw worse. The face looking that way reads shallower by
 * 12 x lean, the one behind it steeper by as much.
 */
function leaning(syn: SyntheticRoof, lean: number): SyntheticRoof {
  const { width: W, height: H, pixelSizeM: s } = syn.raster;
  const o = syn.toLocal({ x: 0, y: 0 });
  const y1 = syn.toLocal({ x: 0, y: 1 });
  const ey = { x: y1.x - o.x, y: y1.y - o.y };
  const dsm = new Float32Array(syn.raster.dsm);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) dsm[r * W + c]! += lean * (((c + 0.5) * s - o.x) * ey.x + (-(r + 0.5) * s - o.y) * ey.y);
  }
  return { ...syn, raster: { ...syn.raster, dsm } };
}

describe('weightedMedian', () => {
  it('is the mean of two equal faces, the value of a face holding most of the area, and steady when an area moves a little', () => {
    expect(weightedMedian([{ v: 5.4, w: 55 }, { v: 6.6, w: 55 }])).toBeCloseTo(6, 6);
    expect(weightedMedian([{ v: 6.6, w: 55 }, { v: 5.4, w: 55.0001 }])).toBeCloseTo(6, 3);
    expect(weightedMedian([{ v: 4, w: 5 }, { v: 6, w: 90 }, { v: 9, w: 5 }])).toBe(6);
    // One far reading among several does not drag it: the mean of these is 7.5.
    expect(weightedMedian([{ v: 6, w: 30 }, { v: 6.1, w: 30 }, { v: 5.9, w: 30 }, { v: 12, w: 30 }])).toBeLessThan(6.2);
    expect(weightedMedian([{ v: 7, w: 10 }])).toBe(7);
  });
});

describe('reportedPitches', () => {
  it('faces of one pitch read apart report one pitch; without pooling each reports its own', () => {
    // A 6/12 hip on a leaning height map: the two long faces read 5.4 and 6.6, the two ends 6.03.
    const faces = [face(5.4, 55), face(6.6, 55), face(6.03, 25), face(6.03, 25)];
    const pooled = reportedPitches(faces);
    expect(pooled.groups).toHaveLength(1);
    expect(pooled.groups[0]!.faces).toEqual([0, 1, 2, 3]);
    for (const p of pooled.pitchX12) expect(p).toBeCloseTo(6.03, 2);
    expect(reportedPitches(faces, OWN).pitchX12).toEqual([5.4, 6.6, 6.03, 6.03]);
    expect(reportedPitches(faces, OWN).groups).toHaveLength(0);
  });

  it('two pitches stay two, the one holding more roof first, and nothing is rounded', () => {
    const faces = [face(8.3, 45), face(7.9, 45), face(5.2, 55), face(4.9, 55), face(5.1, 20)];
    const { pitchX12, groups } = reportedPitches(faces);
    expect(groups.map((g) => g.faces)).toEqual([[2, 3, 4], [0, 1]]);
    expect(pitchX12[0]).toBeCloseTo(8.1, 6);
    expect(pitchX12[1]).toBeCloseTo(8.1, 6);
    expect(pitchX12[2]).toBe(pitchX12[3]);
    expect(pitchX12[2]).toBe(pitchX12[4]);
    expect(pitchX12[2]!).toBeGreaterThan(5);
    expect(pitchX12[2]!).toBeLessThan(5.15);
  });

  it('a small face is held to its own reading less than a large one', () => {
    // 1.3/12 off the group: a 10 m2 dormer face joins it, a 60 m2 face at the same reading is its own pitch.
    const group = [face(8, 60), face(8.1, 60), face(7.9, 40)];
    expect(reportedPitches([...group, face(9.3, 10)]).pitchX12[3]).toBeCloseTo(8, 1);
    expect(reportedPitches([...group, face(9.3, 60)]).pitchX12[3]).toBe(9.3);
  });

  it('a low porch roof beside a steeper roof keeps its pitch, and faces under the low-slope limit join nothing', () => {
    // 3/12 beside 4/12: 1/12 apart is within the tolerance of a large face, but a third of the pitch itself.
    const { pitchX12, groups } = reportedPitches([face(4.1, 60), face(3.9, 60), face(3, 30), face(1.2, 40), face(1.4, 40), face(0.1, 30)]);
    expect(pitchX12[2]).toBe(3);
    expect(pitchX12.slice(3)).toEqual([1.2, 1.4, 0.1]);
    expect(groups).toHaveLength(1);
  });

  it('one face alone, or a group under the smallest share of the roof, is left as read', () => {
    expect(reportedPitches([face(6.4, 80)]).pitchX12).toEqual([6.4]);
    // Two 1.5 m2 scraps agreeing at 12/12 on a 300 m2 roof are not a pitch group.
    const { pitchX12, groups } = reportedPitches([face(6, 150), face(6.1, 147), face(12, 1.5), face(12.2, 1.5)]);
    expect(groups).toHaveLength(1);
    expect(pitchX12.slice(2)).toEqual([12, 12.2]);
  });

  it('the calibration offset comes off every face after pooling, never more than its share of the pitch', () => {
    const faces = [face(6.2, 60), face(6.3, 60), face(9, 50), face(1, 30), face(0, 30)];
    const base = reportedPitches(faces).pitchX12;
    const off = reportedPitches(faces, { ...DEFAULT_PITCH_PARAMS, offsetX12: 0.25 }).pitchX12;
    expect(off[0]).toBeCloseTo(base[0]! - 0.25, 9);
    expect(off[1]).toBeCloseTo(base[1]! - 0.25, 9);
    expect(off[2]).toBeCloseTo(8.75, 9);
    expect(off[3]).toBeCloseTo(0.9, 9);
    expect(off[4]).toBe(0);
  });

  it('the sloped area is worked out with the pitch before the offset unless offsetArea says to follow it', () => {
    const faces = [face(6.2, 60), face(6.3, 60), face(9, 50)];
    const base = reportedPitches(faces);
    expect(base.areaPitchX12).toEqual(base.pitchX12);
    const off = reportedPitches(faces, { ...DEFAULT_PITCH_PARAMS, offsetX12: 0.25 });
    expect(off.areaPitchX12).toEqual(base.pitchX12);
    const follow = reportedPitches(faces, { ...DEFAULT_PITCH_PARAMS, offsetX12: 0.25, offsetArea: true });
    expect(follow.areaPitchX12).toEqual(follow.pitchX12);
    expect(follow.pitchX12).toEqual(off.pitchX12);
  });

  it('is the same for the same faces, and does not depend on the order of equal readings', () => {
    const faces = [face(7.2, 30), face(6.8, 30), face(7.0, 12), face(12.4, 40), face(11.8, 40), face(3, 9)];
    const a = reportedPitches(faces);
    expect(reportedPitches(faces)).toEqual(a);
    const back = reportedPitches([...faces].reverse()).pitchX12.reverse();
    back.forEach((p, k) => expect(p).toBeCloseTo(a.pitchX12[k]!, 9));
  });
});

describe('the pitch a reconstructed roof reports', () => {
  // A 16 x 10 m hip at 6/12 whose height map leans 0.6/12 across the ridge.
  const syn = leaning(synthesize(hipShape(16, 10, 6), { turnDeg: 17 }), 0.05);
  const own = reconstructRoof(syn.raster, syn.point, { pitch: { pool: false } })!;
  const pooled = reconstructRoof(syn.raster, syn.point)!;
  const at = (roof: LocalRoof, name: string) => roof.faces.find((f) => inside(syn.toLocal(syn.faces.find((t) => t.name === name)!.probe), f.ring))!;

  it('on a leaning height map each face alone reads the long faces 0.6/12 off, and the wrong main pitch', () => {
    expect(own.faces).toHaveLength(4);
    expect(Math.abs(at(own, 'north').pitchX12 - 6)).toBeGreaterThan(0.45);
    expect(Math.abs(at(own, 'south').pitchX12 - 6)).toBeGreaterThan(0.45);
    expect(Math.abs(at(own, 'north').pitchX12 - at(own, 'south').pitchX12)).toBeGreaterThan(1);
    expect(mainPitch(own)).not.toBe(6);
  });

  it('pooled, all four faces report the roof\'s one pitch and the main pitch is right', () => {
    expect(pooled.faces).toHaveLength(4);
    for (const f of pooled.faces) {
      expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.2);
      expect(f.pitchX12).toBe(pooled.faces[0]!.pitchX12);
    }
    expect(mainPitch(pooled)).toBe(6);
  });

  it('the planes, the outline and every line are as fitted; only the pitch and the sloped area that follows from it move', () => {
    expect(pooled.outline).toEqual(own.outline);
    expect(pooled.lines).toEqual(own.lines);
    pooled.faces.forEach((f, k) => {
      const g = own.faces[k]!;
      expect(f.plane).toEqual(g.plane);
      expect(f.ring).toEqual(g.ring);
      expect(f.planAreaM2).toBe(g.planAreaM2);
      expect(f.azimuthDeg).toBe(g.azimuthDeg);
      expect(f.slopedAreaM2).toBeCloseTo(f.planAreaM2 * Math.hypot(1, f.pitchX12 / 12), 9);
      // The plane still says what the heights said, and the face keeps that reading beside the one it reports.
      expect(Math.hypot(f.plane.a, f.plane.b) * 12).toBeCloseTo(g.pitchX12, 9);
      expect(f.fitPitchX12).toBe(g.pitchX12);
      expect(g.fitPitchX12).toBe(g.pitchX12);
    });
    // The leaning roof's sloped area: 160 m2 of plan at 6/12.
    const sloped = pooled.faces.reduce((t, f) => t + f.slopedAreaM2, 0);
    expect(Math.abs(sloped / (160 * Math.hypot(1, 0.5)) - 1)).toBeLessThan(0.02);
  });

  it('roofs built with two pitches keep both', () => {
    const two = synthesize(TWO_STOREY, { turnDeg: 17 });
    const r = reconstructRoof(two.raster, two.point)!;
    for (const truth of two.faces) {
      const f = r.faces.find((g) => inside(two.toLocal(truth.probe), g.ring))!;
      expect(Math.abs(f.pitchX12 - truth.pitchX12), truth.name).toBeLessThan(0.3);
    }
    const porch = synthesize(PORCH, { turnDeg: 17 });
    const p = reconstructRoof(porch.raster, porch.point)!;
    const low = p.faces.find((g) => inside(porch.toLocal({ x: 0, y: -5.5 }), g.ring))!;
    expect(Math.abs(low.pitchX12 - 3)).toBeLessThan(0.3);
    expect(Math.abs(p.faces.find((g) => inside(porch.toLocal({ x: 0, y: 2 }), g.ring))!.pitchX12 - 6)).toBeLessThan(0.3);
  });

  it('the offset option lowers every sloped face by that much; the sloped area follows only with offsetArea; the flat flag is the plane\'s', () => {
    const off = reconstructRoof(syn.raster, syn.point, { pitch: { offsetX12: 0.25 } })!;
    const follow = reconstructRoof(syn.raster, syn.point, { pitch: { offsetX12: 0.25, offsetArea: true } })!;
    off.faces.forEach((f, k) => {
      expect(f.pitchX12).toBeCloseTo(pooled.faces[k]!.pitchX12 - 0.25, 9);
      expect(f.fitPitchX12).toBe(pooled.faces[k]!.fitPitchX12);
      expect(f.slopedAreaM2).toBe(pooled.faces[k]!.slopedAreaM2);
      expect(f.flat).toBe(pooled.faces[k]!.flat);
      expect(follow.faces[k]!.pitchX12).toBe(f.pitchX12);
      expect(follow.faces[k]!.slopedAreaM2).toBeCloseTo(f.planAreaM2 * Math.hypot(1, f.pitchX12 / 12), 9);
      expect(follow.faces[k]!.slopedAreaM2).toBeLessThan(f.slopedAreaM2);
    });
    expect(off.lines).toEqual(pooled.lines);
  });
});
