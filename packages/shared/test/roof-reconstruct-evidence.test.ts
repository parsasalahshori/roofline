// Faces kept or dropped on evidence read off the height map, not on size (roof-reconstruct/faces-evidence.ts): a face
// with a ridge or hip of its own is real whatever its size; a strip along a ridge is a fragment of the slope it lies
// on, whatever it meets across the ridge. And buildFaces' cleanup runs to its end (the round budget, the split that
// was dissolved and split again). Hermetic: synthetic height maps only.
import { describe, expect, it } from 'vitest';
import { bowExplained, DEFAULT_EVIDENCE, type EvidenceParams, evidenceStands, faceEvidence, fragmentOf, measureFaces, offNeighbours, ownCreaseM, ownFacingOf, realFaces } from '../src/roof-reconstruct/faces-evidence.ts';
import { squaredDistance } from '../src/roof-reconstruct/raster.ts';
import { reconstructRoof, toRoof3d } from '../src/roof-reconstruct/index.ts';
import { buildFaces, DEFAULT_PLANE_PARAMS, type FaceHooks, type Faces, type FoundPlane, type Plane, type PlaneParams } from '../src/roof-reconstruct/planes.ts';

const S = 0.1;

/** A grid of `wM` x `hM` metres (0.1 m pixels) cut into faces by `label` (x east, y north from the top-left; -1: no roof), heights on `planes`. */
function scene(wM: number, hM: number, label: (x: number, y: number) => number, planes: Plane[]) {
  const g = { w: Math.round(wM / S), h: Math.round(hM / S) };
  const labels = new Int32Array(g.w * g.h);
  const dsm = new Float32Array(g.w * g.h);
  const roof = new Uint8Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const x = (c + 0.5) * S;
      const y = -(r + 0.5) * S;
      const k = label(x, y);
      labels[r * g.w + c] = k;
      roof[r * g.w + c] = k >= 0 ? 1 : 0;
      dsm[r * g.w + c] = k >= 0 ? planes[k]!.a * x + planes[k]!.b * y + planes[k]!.c : 0;
    }
  }
  // What the plane search would hand buildFaces: each plane with the pixels on it.
  const found: FoundPlane[] = planes.map((plane, k) => ({ plane, patch: Uint8Array.from(labels, (l) => (l === k ? 1 : 0)) }));
  return { g, dsm, roof, faces: { labels, planes } as Faces, found };
}

/** The evidence rules as index.ts hooks them into buildFaces. */
function hooks(sc: ReturnType<typeof scene>, prm: EvidenceParams = DEFAULT_EVIDENCE): FaceHooks {
  return { real: (f) => realFaces(sc.g, S, sc.dsm, f, DEFAULT_PLANE_PARAMS, null, prm) };
}

/** How many faces of `f` lie on a plane facing within 20 degrees of `downDeg` (clockwise from north) at `pitchX12` (within 1.5). */
function facesLike(f: Faces, downDeg: number, pitchX12: number): number {
  return f.planes.filter((p) => {
    const az = (((Math.atan2(-p.a, -p.b) * 180) / Math.PI) % 360 + 360) % 360;
    const d = Math.abs(az - downDeg) % 360;
    return Math.min(d, 360 - d) < 20 && Math.abs(Math.hypot(p.a, p.b) * 12 - pitchX12) < 1.5;
  }).length;
}

// A slope down to the south at 6/12 with a gable dormer on it: ridge along x = 4 at 4.2 m, its two faces at 8/12 down
// to the west and to the east, front wall at y = -6.5 (the slope goes on below it). Each dormer face is 3.1 m2 of
// plan, inside the roof: a small face by every size rule.
const P = 8 / 12;
const MAIN: Plane = { a: 0, b: 0.5, c: 6 };
const WEST: Plane = { a: P, b: 0, c: 4.2 - 4 * P };
const EAST: Plane = { a: -P, b: 0, c: 4.2 + 4 * P };
function dormer(rough: boolean) {
  const inDormer = (x: number, y: number) => y > -6.5 && y < -3.6 - (P / 0.5) * Math.abs(x - 4);
  const sc = scene(8, 8, (x, y) => (inDormer(x, y) ? (x < 4 ? 1 : 2) : 0), [MAIN, WEST, EAST]);
  // Rough heights on the dormer (shingle courses, a smeared height map): every third pixel 0.25 m off its plane, so no
  // size rule's "a clean plane of its own" exception holds for it.
  if (rough) for (let i = 0; i < sc.dsm.length; i++) if (sc.faces.labels[i]! > 0 && i % 3 === 0) sc.dsm[i]! += 0.25;
  return sc;
}

describe('a ridge or hip of its own (ownCreaseM, realFaces)', () => {
  it('each face of a gable dormer has one with the other (the height map turns over between them); the slope under them has none', () => {
    const sc = dormer(false);
    const m = measureFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS);
    expect(ownCreaseM(m[1]!, DEFAULT_EVIDENCE)).toBeGreaterThan(2);
    expect(ownCreaseM(m[2]!, DEFAULT_EVIDENCE)).toBeGreaterThan(2);
    expect(ownCreaseM(m[0]!, DEFAULT_EVIDENCE)).toBe(0);
    expect([...realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, { ...DEFAULT_EVIDENCE, ownArcDeg: 0 })]).toEqual([0, 1, 1]);
  });

  it('what the boundary is made of: a valley with the slope (the heights turn up), a ridge with the other face (they turn over), no step', () => {
    const m = measureFaces(dormer(false).g, S, dormer(false).dsm, dormer(false).faces, DEFAULT_PLANE_PARAMS);
    const withMain = m[1]!.relations.find((q) => q.m === 0)!;
    const withEast = m[1]!.relations.find((q) => q.m === 2)!;
    expect(withMain.kink).toBeGreaterThan(0.15);
    expect(withEast.kink).toBeLessThan(-1);
    expect(withEast.arc).toBeGreaterThan(170);
    expect(Math.abs(withEast.step)).toBeLessThan(0.1);
  });

  it('rough heights do not hide the ridge (the turn is a median along the boundary)', () => {
    const sc = dormer(true);
    expect([...realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, { ...DEFAULT_EVIDENCE, ownArcDeg: 0 })]).toEqual([0, 1, 1]);
  });

  it('a valley is no ridge, and a wall\'s smear under a flat roof has no ridge with it (pitches far apart)', () => {
    // Two faces coming down to x = 4: a valley.
    const valley = scene(8, 8, (x) => (x < 4 ? 0 : 1), [{ a: -P, b: 0, c: 8 * P }, { a: P, b: 0, c: 0 }]);
    const mv = measureFaces(valley.g, S, valley.dsm, valley.faces, DEFAULT_PLANE_PARAMS);
    expect(mv[0]!.relations[0]!.kink).toBeGreaterThan(1);
    expect(ownCreaseM(mv[0]!, DEFAULT_EVIDENCE)).toBe(0);
    expect(ownCreaseM(mv[1]!, DEFAULT_EVIDENCE)).toBe(0);
    // A flat roof west of x = 4 and, east of it, the height map's smear down its wall (18/12 down to the east).
    const wall = scene(8, 8, (x) => (x < 4 ? 0 : 1), [{ a: 0.02, b: 0, c: 5 }, { a: -1.5, b: 0, c: 5.08 + 6 }]);
    const m = measureFaces(wall.g, S, wall.dsm, wall.faces, DEFAULT_PLANE_PARAMS);
    expect(m[1]!.relations[0]!.kink).toBeLessThan(-1);
    expect(ownCreaseM(m[1]!, DEFAULT_EVIDENCE)).toBe(0);
  });

  it('a face by a tree crown is not kept on this evidence (a crown is a little hip roof to a height map)', () => {
    const sc = dormer(false);
    const tree = Uint8Array.from(sc.faces.labels, (l) => (l === 2 ? 1 : 0));
    const real = realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, tree, DEFAULT_EVIDENCE);
    expect([real[1], real[2]]).toEqual([0, 0]);
  });
});

describe('a facing of its own (ownFacingOf)', () => {
  // A hip end: west of x = 4 a slope down to the west, east of it one down to the south, both at 6/12.
  const hip = scene(8, 8, (x) => (x < 4 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 0, b: 0.5, c: 6 }]);
  it('a face none of whose pitched neighbours looks its way has one; off (ownArcDeg 0) it has not', () => {
    const m = measureFaces(hip.g, S, hip.dsm, hip.faces, DEFAULT_PLANE_PARAMS);
    expect(ownFacingOf(m[1]!, DEFAULT_EVIDENCE)).toBe(true);
    expect(ownFacingOf(m[1]!, { ...DEFAULT_EVIDENCE, ownArcDeg: 0 })).toBe(false);
  });
  it('a strip of a slope beside the rest of it has none, nor has a nearly level face, nor a face beside nothing pitched', () => {
    const strips = scene(8, 8, (x) => (x < 4 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 7 / 12, b: 0, c: -1 / 3 }]);
    const ms = measureFaces(strips.g, S, strips.dsm, strips.faces, DEFAULT_PLANE_PARAMS);
    expect(ownFacingOf(ms[0]!, DEFAULT_EVIDENCE)).toBe(false);
    expect(ownFacingOf(ms[1]!, DEFAULT_EVIDENCE)).toBe(false);
    const flat = scene(8, 8, (x) => (x < 4 ? 0 : 1), [{ a: 0.5, b: 0, c: 0 }, { a: 0, b: 0.05, c: 2 }]);
    const mf = measureFaces(flat.g, S, flat.dsm, flat.faces, DEFAULT_PLANE_PARAMS);
    expect(ownFacingOf(mf[1]!, DEFAULT_EVIDENCE)).toBe(false);
    expect(ownFacingOf(mf[0]!, DEFAULT_EVIDENCE)).toBe(false);
  });
});

// A gable (ridge along x = 4, both slopes at 8/12) whose top the height map has rounded off: a strip 0.7 m wide just
// west of the ridge at 5/12, facing west like the slope under it. It meets the east slope at a convex crease at about
// its own pitch: a ridge of its own, by the letter.
const W8: Plane = { a: P, b: 0, c: 0 };
const E8: Plane = { a: -P, b: 0, c: 8 * P };
const CAP: Plane = { a: 5 / 12, b: 0, c: 0.85 };
function roundedRidge() {
  const z = (p: Plane, x: number) => p.a * x + p.c;
  return scene(8, 8, (x) => (z(CAP, x) < z(W8, x) && z(CAP, x) < z(E8, x) ? 2 : x < 4 ? 0 : 1), [W8, E8, CAP]);
}

describe('a fragment is not a face (fragmentOf)', () => {
  it('the strip along the ridge is a fragment of the slope it lies on, so it is not real, whatever it meets across the ridge', () => {
    const sc = roundedRidge();
    const m = measureFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS);
    expect(ownCreaseM(m[2]!, DEFAULT_EVIDENCE)).toBeGreaterThan(5);
    expect(fragmentOf(m[2]!, DEFAULT_EVIDENCE)?.m).toBe(0);
    expect(realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, DEFAULT_EVIDENCE)[2]).toBe(0);
    // Without the fragment rule (fragWidthM 0) the same strip would be kept for its ridge.
    expect(realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, { ...DEFAULT_EVIDENCE, fragWidthM: 0 })[2]).toBe(1);
  });

  it('neither slope of the gable is a fragment (a face is a fragment only of a bigger one that faces its way), and a dormer face is none', () => {
    const sc = roundedRidge();
    const m = measureFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS);
    expect(fragmentOf(m[0]!, DEFAULT_EVIDENCE)).toBeNull();
    expect(fragmentOf(m[1]!, DEFAULT_EVIDENCE)).toBeNull();
    const d = dormer(false);
    const md = measureFaces(d.g, S, d.dsm, d.faces, DEFAULT_PLANE_PARAMS);
    expect(fragmentOf(md[1]!, DEFAULT_EVIDENCE)).toBeNull();
    expect(fragmentOf(md[2]!, DEFAULT_EVIDENCE)).toBeNull();
  });

  it('a strip held off its slope by a step (a wall between them) is no fragment of it', () => {
    // The west slope, and east of x = 4 a strip of the same slope 0.6 m higher (a parapet, a raised bay).
    const sc = scene(8, 8, (x) => (x < 4 ? 0 : x < 4.7 ? 1 : -1), [W8, { a: P, b: 0, c: 0.6 }]);
    const m = measureFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS);
    expect(Math.abs(m[1]!.relations[0]!.step)).toBeGreaterThan(0.4);
    expect(fragmentOf(m[1]!, DEFAULT_EVIDENCE)).toBeNull();
  });
});

describe('buildFaces with the evidence rules', () => {
  it('a small rough dormer survives the size rules on its evidence, and is dissolved without it', () => {
    const sc = dormer(true);
    const kept = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, hooks(sc));
    expect(facesLike(kept, 270, 8)).toBe(1);
    expect(facesLike(kept, 90, 8)).toBe(1);
    expect(kept.planes.length).toBe(3);
    const lost = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS);
    expect(lost.planes.length).toBe(1);
  });

  it('the faces it keeps against a size rule are marked unsure (they stay only when not thin: evidence.thinM)', () => {
    const sc = dormer(true);
    const unsure = new Uint8Array(sc.roof.length);
    const kept = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, unsure, hooks(sc));
    let marked = 0;
    let dormerPx = 0;
    for (let i = 0; i < unsure.length; i++) {
      const onDormer = Math.hypot(kept.planes[kept.labels[i]!]!.a, kept.planes[kept.labels[i]!]!.b) * 12 > 7;
      if (onDormer) dormerPx++;
      if (unsure[i] === 1) {
        expect(onDormer).toBe(true);
        marked++;
      }
    }
    expect(marked).toBe(dormerPx);
    expect(marked).toBeGreaterThan(500);
  });

  it('the strip along a ridge does not survive: it is dissolved with the evidence rules on as with them off', () => {
    const sc = roundedRidge();
    const on = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, hooks(sc));
    expect(on.planes.length).toBe(2);
    expect(facesLike(on, 270, 5)).toBe(0);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS).planes.length).toBe(2);
    // The crease rule alone (no fragment rule) would have kept it.
    const naive = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, hooks(sc, { ...DEFAULT_EVIDENCE, fragWidthM: 0 }));
    expect(facesLike(naive, 270, 5)).toBe(1);
  });
});

describe('buildFaces: the cleanup runs to its end', () => {
  const OLD: PlaneParams = { ...DEFAULT_PLANE_PARAMS, cleanupRoundsPerFace: 0, splitOnce: false };
  const TO_THE_END: PlaneParams = { ...DEFAULT_PLANE_PARAMS, cleanupRoundsPerFace: 1, splitOnce: true };
  const main: Plane = { a: 0, b: 0.5, c: 6 };

  it('a part split off at a neck and dissolved is not split off again (it used to take every round, and the later steps never ran)', () => {
    // One plane over two rooms joined by a 0.6 m neck (the smaller room is split off, then explained by the bigger one's
    // plane, its pixels flood back, and it was split off again), and along the big room's eave a wall's smear (a
    // riser: step 4 dissolves it, when the rounds reach step 4).
    const eave = (x: number, y: number) => x > 0.5 && x < 6.5 && y <= -6.4 && y > -7;
    const big = (x: number, y: number) => x > 0.5 && x < 6.5 && y < -1 && y > -6.4;
    const neck = (x: number, y: number) => x >= 6.5 && x <= 7.5 && y < -3.7 && y > -4.3;
    const small = (x: number, y: number) => x > 7.5 && x < 10 && y < -2.75 && y > -5.25;
    const smear: Plane = { a: 0, b: 16 / 12, c: 6 + 0.5 * -6.4 - (16 / 12) * -6.4 };
    const sc = scene(11, 8, (x, y) => (eave(x, y) ? 1 : big(x, y) || neck(x, y) || small(x, y) ? 0 : -1), [main, smear]);
    const said = (prm: PlaneParams) => {
      const lines: string[] = [];
      const faces = buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, prm, null, (m) => lines.push(m));
      return { faces, explained: lines.filter((l) => l.startsWith('faces: explained')).length, riser: lines.filter((l) => l.startsWith('faces: chamfer/riser')).length };
    };
    const now = said(TO_THE_END);
    expect(now.explained).toBe(1);
    expect(now.riser).toBe(1);
    expect(now.faces.planes.length).toBe(1);
    const before = said(OLD);
    expect(before.explained).toBe(6);
    expect(before.riser).toBe(0);
    expect(before.faces.planes.length).toBe(2);
  });

  it('there is a round for every face: fourteen smears along one eave are all dissolved (twelve rounds dissolved twelve)', () => {
    // A long slope with fourteen separate steep strips along its eave, each dissolved alone (one a round).
    const strip = (x: number, y: number) => y <= -5.3 && y > -6 && x > 0.5 && x < 63.5 && (x - 0.5) % 4.5 < 4;
    const smear: Plane = { a: 0, b: 16 / 12, c: 6 + 0.5 * -5.3 - (16 / 12) * -5.3 };
    const sc = scene(64, 7, (x, y) => (strip(x, y) ? 1 : x > 0.5 && x < 63.5 && y < -1 && y > -6 ? 0 : -1), [main, smear]);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, TO_THE_END).planes.length).toBe(1);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, OLD).planes.length).toBe(3);
  });
});

describe('reconstructRoof: the evidence switch', () => {
  it('off by default; on (with the cleanup run to its end) a roof with nothing small on it comes out the same', () => {
    // A plain gable (two big faces): no rule has anything to decide.
    const W = 160;
    const dsm = new Float32Array(W * W);
    const mask = new Uint8Array(W * W);
    for (let r = 0; r < W; r++) {
      for (let c = 0; c < W; c++) {
        const x = (c + 0.5) * S - 8;
        const y = 8 - (r + 0.5) * S;
        const on = Math.abs(x) < 5 && Math.abs(y) < 4;
        mask[r * W + c] = on ? 1 : 0;
        dsm[r * W + c] = on ? 3 + (4 - Math.abs(y)) * 0.5 : 0;
      }
    }
    const raster = { width: W, height: W, pixelSizeM: S, dsm, mask };
    const on = reconstructRoof(raster, { col: W / 2, row: W / 2 }, { seed: 7, evidence: { enabled: true }, planes: { cleanupRoundsPerFace: 1, splitOnce: true } });
    const off = reconstructRoof(raster, { col: W / 2, row: W / 2 }, { seed: 7 });
    expect(on).not.toBeNull();
    expect(on!.faces.length).toBe(2);
    // The same roof; on, each face says what it stands on (a ridge of its own), off nothing does.
    expect(on!.faces.map((f) => f.evidence)).toEqual(['crease', 'crease']);
    expect(off!.faces.every((f) => f.evidence === undefined)).toBe(true);
    const bare = on!.faces.map((f) => {
      const g = { ...f };
      delete g.evidence;
      return g;
    });
    expect(JSON.stringify({ ...on, faces: bare })).toBe(JSON.stringify(off));
    // Stored as it is measured; a stored roof without it reads as before.
    const stored = toRoof3d(on!, (x, y) => [x, y], { imageryQuality: 'HIGH', imageryDate: null });
    expect(stored.faces.map((f) => f.evidence)).toEqual(['crease', 'crease']);
    expect(toRoof3d(off!, (x, y) => [x, y], { imageryQuality: 'HIGH', imageryDate: null }).faces.every((f) => !('evidence' in f))).toBe(true);
  });
});

describe('faceEvidence: what a face stands on (stored as Roof3dFace.evidence)', () => {
  it("a gable dormer's faces have a ridge of their own; the slope under them is the only face looking its way", () => {
    const sc = dormer(false);
    expect(faceEvidence(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, DEFAULT_EVIDENCE)).toEqual(['facing', 'crease', 'crease']);
    // realFaces is 1 exactly where there is evidence.
    expect([...realFaces(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, DEFAULT_EVIDENCE)]).toEqual([1, 1, 1]);
  });

  it('a strip along a ridge (a fragment of its slope) has none, whatever it meets across the ridge', () => {
    const sc = roundedRidge();
    const ev = faceEvidence(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, DEFAULT_EVIDENCE);
    expect(ev[2]).toBeNull();
    // ...while without the fragment rule it would stand on the ridge it meets.
    expect(faceEvidence(sc.g, S, sc.dsm, sc.faces, DEFAULT_PLANE_PARAMS, null, { ...DEFAULT_EVIDENCE, fragWidthM: 0 })[2]).toBe('crease');
  });
});

describe('negative evidence before a size rule deletes a face (evidence.bowM)', () => {
  // A slope down to the south at 6/12 (y from -1 to -7), and along its eave a steeper strip facing the same way: a
  // porch roof 1.4 m deep at 12/12 (a face of its own: its heights fall 0.7 m below the slope's plane carried on), or a
  // smear 0.4 m deep at 13/12 (the height map's roll-off at the eave: within 0.2 m of the slope's plane). Rough heights
  // on the strip (every third pixel 0.2 m up), so the steep rule's "clean plane of its own" exception does not hold.
  const main: Plane = { a: 0, b: 0.5, c: 6 };
  const strip = (depthM: number, x12: number) => {
    const top = -7 + depthM;
    const steep: Plane = { a: 0, b: x12 / 12, c: main.b * top + main.c - (x12 / 12) * top };
    const sc = scene(8, 8, (x, y) => (x < 0.5 || x > 7.5 || y > -1 || y < -7 ? -1 : y < top && x > 1.5 && x < 6.5 ? 1 : 0), [main, steep]);
    for (let i = 0; i < sc.dsm.length; i++) if (sc.faces.labels[i] === 1 && i % 3 === 0) sc.dsm[i]! += 0.2;
    return sc;
  };
  const negative = (sc: ReturnType<typeof strip>, prm: EvidenceParams): FaceHooks => ({
    real: (f) => realFaces(sc.g, S, sc.dsm, f, DEFAULT_PLANE_PARAMS, null, prm),
    negative: (f, k, near) => bowExplained(sc.g, S, sc.dsm, f, k, near, prm, squaredDistance(sc.g, (i) => f.labels[i]! < 0, true)),
  });
  const ON: EvidenceParams = { ...DEFAULT_EVIDENCE, enabled: true, thinM: 0, bowM: 0.25 };

  it('a porch roof along the eave stands off the slope it meets and stays; the size rule alone dissolves it', () => {
    const sc = strip(1.4, 12);
    expect(offNeighbours(sc.g, S, sc.dsm, sc.faces, 1, [0])).toBeGreaterThan(0.25);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, negative(sc, ON)).planes.length).toBe(2);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, hooks(sc, ON)).planes.length).toBe(1);
  });

  it("the eave's smear lies on the slope's plane within the bow and is still dissolved", () => {
    const sc = strip(0.4, 13);
    expect(offNeighbours(sc.g, S, sc.dsm, sc.faces, 1, [0])).toBeLessThan(0.25);
    expect(buildFaces(sc.g, S, sc.dsm, sc.roof, sc.found, DEFAULT_PLANE_PARAMS, null, undefined, null, negative(sc, ON)).planes.length).toBe(1);
  });
});

describe('what a face real on its evidence stands against in the weak-face cleanup (evidenceStands)', () => {
  const ON: EvidenceParams = { ...DEFAULT_EVIDENCE, enabled: true, thinM: 0 };
  it('a thin piece on a neighbour plane is that face cut in two, like a fragment: it goes unless keepCoplanar', () => {
    expect(evidenceStands('thin-coplanar', 0.6, ON)).toBe(false);
    expect(evidenceStands('thin-coplanar', 0.6, { ...ON, keepCoplanar: true })).toBe(true);
  });
  it('it stands against the edge and unsure rules when not thinner than thinM, never against steep-unsupported', () => {
    expect(evidenceStands('thin-edge', 0.6, ON)).toBe(true);
    expect(evidenceStands('thin-unsure', 0.6, ON)).toBe(true);
    expect(evidenceStands('thin-edge', 0.6, { ...ON, thinM: 0.9 })).toBe(false);
    expect(evidenceStands('steep-unsupported', 2, ON)).toBe(false);
  });
});
