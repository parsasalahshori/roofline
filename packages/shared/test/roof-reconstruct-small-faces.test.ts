// Small faces: the planes found late in a long search make faces only when those are not thin; and (off by default)
// small faces with evidence of their own (a ridge partner, a facing direction of their own) stay, where the strips of
// a bowed slope have neither. A face added or kept this way is unsure: it must not be thin.
import { describe, expect, it } from 'vitest';
import { DEFAULT_FACE_CLEANUP, type FaceSupport, weakFaces } from '../src/roof-reconstruct/faces-cleanup.ts';
import { reconstructRoof } from '../src/roof-reconstruct/index.ts';
import { adjacency, DEFAULT_PLANE_PARAMS, ownFacing, type Plane, type PlaneParams, ridgePartner } from '../src/roof-reconstruct/planes.ts';
import { DORMER_GABLE, STEEP_DORMER } from './fixtures/hard-roofs.ts';
import { synthesize } from './fixtures/synthetic-roofs.ts';

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** The evidence rules on (they are off by default: see PlaneParams.pairFacingDeg). */
const KEEP = { pairFacingDeg: 135, ownFacingDeg: 45 };
const ON: PlaneParams = { ...DEFAULT_PLANE_PARAMS, ...KEEP };

/** A 6 x 6 m grid (0.1 m pixels) cut into faces by `label` (x east, y north from the top-left), heights on `planes`. */
function scene(label: (x: number, y: number) => number, planes: Plane[]) {
  const s = 0.1;
  const g = { w: 60, h: 60 };
  const labels = new Int32Array(g.w * g.h);
  const dsm = new Float32Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const x = (c + 0.5) * s;
      const y = -(r + 0.5) * s;
      const k = label(x, y);
      labels[r * g.w + c] = k;
      dsm[r * g.w + c] = planes[k]!.a * x + planes[k]!.b * y + planes[k]!.c;
    }
  }
  const faces = { labels, planes };
  return { g, s, dsm, faces, adj: adjacency(g, labels, planes.length) };
}

describe('ridgePartner: a ridge of its own', () => {
  // Two faces falling away from the line x = 3 at 10/12: west of it down to the west, east of it down to the east.
  const p = 10 / 12;
  const gable = (stepM: number) => scene((x) => (x < 3 ? 0 : 1), [{ a: p, b: 0, c: 0 }, { a: -p, b: 0, c: 6 * p + stepM }]);

  it('the two faces of a gable are each other\'s partner', () => {
    const { g, s, faces, adj } = gable(0);
    expect(ridgePartner(g, s, faces, adj, 0, ON)).toBe(1);
    expect(ridgePartner(g, s, faces, adj, 1, ON)).toBe(0);
  });

  it('off (pairFacingDeg 0) nothing has a partner', () => {
    const { g, s, faces, adj } = gable(0);
    expect(ridgePartner(g, s, faces, adj, 0, { ...ON, pairFacingDeg: 0 })).toBe(-1);
  });

  it('two faces held apart by a wall (their planes do not meet at the boundary) are no pair', () => {
    const { g, s, faces, adj } = gable(1.5);
    expect(ridgePartner(g, s, faces, adj, 0, ON)).toBe(-1);
  });

  it('a valley is no ridge: two faces coming down to their boundary are no pair', () => {
    const { g, s, faces, adj } = scene((x) => (x < 3 ? 0 : 1), [{ a: -p, b: 0, c: 6 * p }, { a: p, b: 0, c: 0 }]);
    expect(ridgePartner(g, s, faces, adj, 0, ON)).toBe(-1);
  });

  it('a steep face beside a shallow one facing the other way (pitches more than pairX12 apart) is no pair', () => {
    const { g, s, faces, adj } = scene((x) => (x < 3 ? 0 : 1), [{ a: 16 / 12, b: 0, c: 0 }, { a: -4 / 12, b: 0, c: 3 * (16 / 12) + 3 * (4 / 12) }]);
    expect(ridgePartner(g, s, faces, adj, 0, ON)).toBe(-1);
  });
});

describe('the strips of a bowed slope have no evidence of their own', () => {
  // One slope down to the west cut into three strips at 5, 6 and 7/12 (what a bowed height map is fitted with).
  const cut = scene((x) => (x < 2 ? 0 : x < 4 ? 1 : 2), [
    { a: 5 / 12, b: 0, c: 0 },
    { a: 6 / 12, b: 0, c: 2 * (5 / 12) - 2 * (6 / 12) },
    { a: 7 / 12, b: 0, c: 2 * (5 / 12) + 2 * (6 / 12) - 4 * (7 / 12) },
  ]);
  it('no strip has a ridge partner or a facing direction of its own', () => {
    for (const k of [0, 1, 2]) {
      expect(ridgePartner(cut.g, cut.s, cut.faces, cut.adj, k, ON)).toBe(-1);
      expect(ownFacing(cut.g, cut.s, cut.dsm, cut.faces, cut.adj, k, ON)).toBe(false);
    }
  });
});

describe('ownFacing: a facing direction of its own', () => {
  // West of x = 3 a face down to the west, east of it one down to the south, both at 6/12 (a hip end beside a slope).
  const hip = scene((x) => (x < 3 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 0, b: 0.5, c: 4 }]);
  it('a face square to its only pitched neighbour has one; off (ownFacingDeg 0) it has not', () => {
    expect(ownFacing(hip.g, hip.s, hip.dsm, hip.faces, hip.adj, 1, ON)).toBe(true);
    expect(ownFacing(hip.g, hip.s, hip.dsm, hip.faces, hip.adj, 1, { ...ON, ownFacingDeg: 0 })).toBe(false);
  });
  it('a nearly level face has none, nor a face beside nothing pitched', () => {
    const flat = scene((x) => (x < 3 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 0, b: 0.1, c: 2 }]);
    expect(ownFacing(flat.g, flat.s, flat.dsm, flat.faces, flat.adj, 1, ON)).toBe(false);
    expect(ownFacing(flat.g, flat.s, flat.dsm, flat.faces, flat.adj, 0, ON)).toBe(false);
  });
  it('rough heights (under ownShare of the interior on one plane) give none', () => {
    const rough = scene((x) => (x < 3 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 0, b: 0.5, c: 4 }]);
    // Every other pixel of the east face lifted 0.4 m off its plane.
    for (let i = 0; i < rough.dsm.length; i++) if (rough.faces.labels[i] === 1 && i % 2 === 0) rough.dsm[i]! += 0.4;
    expect(ownFacing(rough.g, rough.s, rough.dsm, rough.faces, rough.adj, 1, ON)).toBe(false);
  });
});

describe('weakFaces: an unsure face must not be thin', () => {
  const face = (o: Partial<FaceSupport>): FaceSupport => ({
    widthM: 2,
    areaM2: 20,
    pitchX12: 6,
    planeShare: 0.95,
    minNeighbourDeg: 40,
    edgeShare: 0.1,
    thicknessM: 2,
    crownShare: 0,
    mainNeighbourX12: 6,
    unsureShare: 0,
    ...o,
  });
  it('thin and unsure goes; thin and sure, or unsure and wide, stays; unsureThinM 0 turns the rule off', () => {
    const thinUnsure = face({ widthM: 0.7, areaM2: 5, unsureShare: 0.8 });
    expect(weakFaces([face({}), thinUnsure]).get(1)).toBe('thin-unsure');
    expect(weakFaces([face({}), face({ widthM: 0.7, areaM2: 5, unsureShare: 0.2 })]).size).toBe(0);
    expect(weakFaces([face({}), face({ widthM: 0.7, areaM2: 5, unsureShare: 0.4 })]).get(1)).toBe('thin-unsure');
    expect(weakFaces([face({}), face({ widthM: 0.7, areaM2: 5, unsureShare: 0.4 })], { ...DEFAULT_FACE_CLEANUP, unsureShare: 0.5 }).size).toBe(0);
    expect(weakFaces([face({}), face({ widthM: 1.2, areaM2: 5, unsureShare: 1 })]).size).toBe(0);
    expect(weakFaces([face({}), thinUnsure], { ...DEFAULT_FACE_CLEANUP, unsureThinM: 0 }).size).toBe(0);
  });
  it('a thin unsure face of any size goes (the benchmark counts every thin face of 25 sq ft or more)', () => {
    expect(weakFaces([face({}), face({ widthM: 0.8, areaM2: 15, unsureShare: 1 })]).get(1)).toBe('thin-unsure');
  });
});

describe('reconstructRoof: a steep dormer on rough heights', () => {
  const dormers = (r: NonNullable<ReturnType<typeof reconstructRoof>>, syn: ReturnType<typeof synthesize>) =>
    STEEP_DORMER.faces.filter((t) => t.name.startsWith('dormer')).map((t) => r.faces.find((c) => arc(c.azimuthDeg, syn.azimuth(t.downDeg)) < 8 && Math.abs(c.pitchX12 - t.pitchX12) < 1.2));

  for (const [turnDeg, seed, noiseM] of [
    [17, 11, 0.08],
    [30, 5, 0.08],
    [17, 11, 0.09],
  ] as const) {
    it(`keeps both dormer faces for their ridge (turned ${turnDeg}, seed ${seed}, noise ${noiseM}); without the rule they are dissolved`, () => {
      const syn = synthesize(STEEP_DORMER, { turnDeg, seed, trees: 0, noiseM });
      const on = reconstructRoof(syn.raster, syn.point, { planes: KEEP })!;
      const found = dormers(on, syn);
      expect(found.every((f) => f !== undefined), on.faces.map((c) => `${c.pitchX12.toFixed(1)}@${c.azimuthDeg.toFixed(0)}`).join(' ')).toBe(true);
      for (const f of found) expect(Math.abs(f!.planAreaM2 / 6.7 - 1)).toBeLessThan(0.25);
      // No junk, and the whole roof.
      for (const f of on.faces) expect(f.planAreaM2).toBeGreaterThanOrEqual(2.32);
      expect(Math.abs(on.faces.reduce((t, f) => t + f.planAreaM2, 0) / STEEP_DORMER.planAreaM2 - 1)).toBeLessThan(0.02);
      const off = reconstructRoof(syn.raster, syn.point)!;
      expect(dormers(off, syn).every((f) => f === undefined)).toBe(true);
    });
  }

  it('either kind of evidence alone keeps them', () => {
    const syn = synthesize(STEEP_DORMER, { turnDeg: 17, seed: 11, trees: 0, noiseM: 0.08 });
    for (const planes of [{ pairFacingDeg: 135 }, { ownFacingDeg: 45 }]) {
      const r = reconstructRoof(syn.raster, syn.point, { planes })!;
      expect(dormers(r, syn).every((f) => f !== undefined)).toBe(true);
    }
  });

  it('a dormer kept for its ridge whose polygons come out thin is given back (thin-unsure), unless unsureThinM is 0', () => {
    const syn = synthesize(STEEP_DORMER, { turnDeg: 30, seed: 5, trees: 0, noiseM: 0.06 });
    const guarded = reconstructRoof(syn.raster, syn.point, { planes: KEEP })!;
    expect(guarded.dissolved?.['thin-unsure']).toBe(2);
    expect(dormers(guarded, syn).every((f) => f === undefined)).toBe(true);
    const open = reconstructRoof(syn.raster, syn.point, { planes: KEEP, faces: { unsureThinM: 0 } })!;
    expect(open.dissolved?.['thin-unsure']).toBeUndefined();
    expect(dormers(open, syn).every((f) => f !== undefined)).toBe(true);
  });
});

describe('reconstructRoof: the planes found after the first surePlanes', () => {
  const facing = (r: NonNullable<ReturnType<typeof reconstructRoof>>, syn: ReturnType<typeof synthesize>, downDeg: number, pitch: number) =>
    r.faces.find((c) => arc(c.azimuthDeg, syn.azimuth(downDeg)) < 8 && Math.abs(c.pitchX12 - pitch) < 1.2);

  it('a search cut short at the main faces misses the dormer; going on finds its faces, which stay when they are not thin', () => {
    const syn = synthesize(STEEP_DORMER, { turnDeg: 17, seed: 11, trees: 0 });
    // Three planes are the roof's own faces (the south one in two parts either side of the dormer).
    const cut = reconstructRoof(syn.raster, syn.point, { planes: { maxPlanes: 3, surePlanes: 3 } })!;
    expect(facing(cut, syn, 0, 10)).toBeUndefined();
    expect(facing(cut, syn, 180, 10)).toBeUndefined();
    const on = reconstructRoof(syn.raster, syn.point, { planes: { maxPlanes: 80, surePlanes: 3 } })!;
    for (const downDeg of [0, 180]) {
      const f = facing(on, syn, downDeg, 10);
      expect(f, on.faces.map((c) => `${c.pitchX12.toFixed(1)}@${c.azimuthDeg.toFixed(0)}`).join(' ')).toBeDefined();
      expect(Math.abs(f!.planAreaM2 / 6.7 - 1)).toBeLessThan(0.25);
    }
    expect(on.dissolved?.['thin-unsure']).toBeUndefined();
  });

  it('late faces that come out thin are given back (thin-unsure); with unsureThinM 0 they stay', () => {
    // The small dormer's faces are about 3 m2 each and under 0.9 m wide.
    const syn = synthesize(DORMER_GABLE, { turnDeg: 17, seed: 11, trees: 0 });
    const sure = reconstructRoof(syn.raster, syn.point)!;
    expect(sure.faces.length).toBe(4);
    const late = reconstructRoof(syn.raster, syn.point, { planes: { surePlanes: 2 } })!;
    expect(late.dissolved?.['thin-unsure']).toBe(2);
    expect(late.faces.length).toBe(2);
    const open = reconstructRoof(syn.raster, syn.point, { planes: { surePlanes: 2 }, faces: { unsureThinM: 0 } })!;
    expect(open.faces.length).toBe(4);
  });

  it('a roof whose search ends before surePlanes is the same roof whatever maxPlanes is', () => {
    const syn = synthesize(DORMER_GABLE, { turnDeg: 30, seed: 5, trees: 0 });
    const a = reconstructRoof(syn.raster, syn.point, { planes: { maxPlanes: 40 } });
    const b = reconstructRoof(syn.raster, syn.point);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
