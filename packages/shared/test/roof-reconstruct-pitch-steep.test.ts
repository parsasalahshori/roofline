// Round 3 of the pitch a face reports (pitch.ts, pitch-stacks.ts; docs/roof-3d/pitch-steep.md): a gable slope mirrored
// from across its ridge is no second reading of the roof's pitch; the two strips of a bowed slope read its chord; two
// pitches a step apart stay two groups; a face measured by lidar does not lose the height map's calibration offset.
// And what did not need changing: a narrow steep roof on a blurred height map already reads its pitch.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PITCH_PARAMS, type LocalRoof, type PitchFace, reconstructRoof, reportedPitches } from '../src/roof-reconstruct/index.ts';
import { scene } from './fixtures/lidar-scene.ts';
import { BOWED_HIP, BOWED_L, gableShape, hipShape, PITCH_BREAK, PORCH, type Shape, synthesize, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

const face = (pitchX12: number, areaM2: number, more: Partial<PitchFace> = {}): PitchFace => ({ pitchX12, areaM2, ...more });
const GOOGLE = { ...DEFAULT_PITCH_PARAMS, offsetX12: 0.25 };
/** As before round 3: every face a reading, no chord, no step, the offset off every face. */
const ROUND_2 = { fittedVote: true, stackChord: false, stepShare: 0, offsetLidar: true } as const;

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** The same roof on a height map that leans `lean` metres of height per metre across the house frame's Y. */
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

/** What every face and line is apart from the pitch reported: the faces' polygons, planes and areas in plan, the lines. */
const drawn = (roof: LocalRoof) => ({ faces: roof.faces.map((f) => ({ ring: f.ring, plane: f.plane, fit: f.fitPitchX12, plan: f.planAreaM2, flat: f.flat })), lines: roof.lines, outline: roof.outline });

describe('reportedPitches: a mirrored slope is a copy, not a reading', () => {
  // A cross gable as the benchmark's ev-51881820 comes out: each gable's bowed slope mirrored from its clean one.
  const faces = [face(7.229, 67.9, { fitted: true }), face(7.227, 43.3), face(6.581, 47.0, { fitted: true }), face(6.632, 11.0), face(6.583, 49.2)];

  it("the roof's pitch is the median of its readings; with every face a reading the copied one weighs twice", () => {
    const { pitchX12, groups } = reportedPitches(faces);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.faces).toEqual([0, 1, 2, 3, 4]);
    expect(groups[0]!.pitchX12).toBeGreaterThan(6.58);
    expect(groups[0]!.pitchX12).toBeLessThan(6.65);
    for (const p of pitchX12) expect(p).toBe(groups[0]!.pitchX12);
    const before = reportedPitches(faces, { ...DEFAULT_PITCH_PARAMS, fittedVote: true });
    expect(before.groups[0]!.pitchX12).toBeGreaterThan(6.75);
    // On Google's height map (0.25/12 off): 6 in 12 against 7 in 12.
    expect(Math.round(reportedPitches(faces, GOOGLE).pitchX12[0]!)).toBe(6);
    expect(Math.round(reportedPitches(faces, { ...GOOGLE, fittedVote: true }).pitchX12[0]!)).toBe(7);
  });

  it('a copy founds no group ahead of the readings, and faces that are all copies still agree on a pitch', () => {
    const roof = [face(9, 100, { fitted: true }), face(9.1, 5), face(6, 40), face(6.1, 40)];
    const now = reportedPitches(roof);
    expect(now.groups.map((g) => g.faces)).toEqual([[2, 3], [0, 1]]);
    // The 9/12 group's pitch is its one reading's.
    expect(now.pitchX12[0]).toBe(9.1);
    expect(reportedPitches(roof, { ...DEFAULT_PITCH_PARAMS, fittedVote: true }).groups.map((g) => g.faces)).toEqual([[0, 1], [2, 3]]);
    const copies = reportedPitches([face(6, 50, { fitted: true }), face(6.2, 50, { fitted: true })]);
    expect(copies.groups).toHaveLength(1);
    expect(copies.pitchX12[0]).toBeCloseTo(6.1, 9);
  });
});

describe('reportedPitches: two pitches a step apart', () => {
  const NO_STEP = { ...DEFAULT_PITCH_PARAMS, stepShare: 0 };

  it('two pairs of faces one pitch step apart stay two groups, whichever holds more roof', () => {
    for (const areas of [[60, 60, 30, 30], [40, 40, 40, 40], [30, 30, 60, 60]] as const) {
      const faces = [face(5.0, areas[0], { azimuthDeg: 0 }), face(5.02, areas[1], { azimuthDeg: 180 }), face(5.98, areas[2], { azimuthDeg: 90 }), face(5.97, areas[3], { azimuthDeg: 270 })];
      const { pitchX12, groups } = reportedPitches(faces);
      expect(groups, `areas ${areas.join()}`).toHaveLength(2);
      expect(pitchX12[0]).toBeCloseTo(5.01, 9);
      expect(pitchX12[1]).toBeCloseTo(5.01, 9);
      expect(pitchX12[2]).toBeCloseTo(5.975, 9);
      expect(pitchX12[3]).toBeCloseTo(5.975, 9);
      // On Google's height map a 5/12 part and a 6/12 part are stored as 5 and 6, not one pitch between.
      expect(reportedPitches(faces, GOOGLE).pitchX12.map((p) => Math.round(p))).toEqual([5, 5, 6, 6]);
      // Before: one group, every face the same pitch.
      const before = reportedPitches(faces, NO_STEP);
      expect(before.groups).toHaveLength(1);
      expect(new Set(before.pitchX12).size).toBe(1);
    }
  });

  it('the higher pair is kept whole when one of its faces is within the lower pitch`s tolerance and the other just outside', () => {
    // A 6/12 wing on a 5/12 roof: one of the wing's slopes reads 0.99 from the main roof's pitch, the other 1.05.
    const faces = [face(5.0, 65, { azimuthDeg: 343 }), face(5.99, 37, { azimuthDeg: 73 }), face(6.05, 37, { azimuthDeg: 253 }), face(5.0, 23, { azimuthDeg: 163 }), face(5.01, 23, { azimuthDeg: 163 })];
    const { pitchX12, groups } = reportedPitches(faces);
    expect(groups.map((g) => g.faces)).toEqual([[0, 3, 4], [1, 2]]);
    expect(pitchX12[1]).toBe(pitchX12[2]);
    expect(pitchX12[1]!).toBeCloseTo(6.02, 9);
    // Before: the wing's east slope reported 5 and its west slope 6.
    const before = reportedPitches(faces, NO_STEP).pitchX12;
    expect(Math.abs(before[1]! - before[2]!)).toBeGreaterThan(0.9);
  });

  it('one pitch read apart stays one group: a leaning roof, a smear of readings, a steep roof`s scatter, faces with no facing', () => {
    // A 6/12 hip on a height map that leans: the faces looking opposite ways are the ones that disagree.
    expect(reportedPitches([face(5.4, 55, { azimuthDeg: 0 }), face(6.6, 55, { azimuthDeg: 180 }), face(6.03, 25, { azimuthDeg: 90 }), face(6.03, 25, { azimuthDeg: 270 })]).groups).toHaveLength(1);
    // Readings all the way from 5 to 6, no gap between them: one pitch read badly, as far as the heights can say.
    const smear = [5.0, 5.02, 5.2, 5.4, 5.6, 5.8, 5.98, 5.97].map((p, k) => face(p, 30, { azimuthDeg: (k % 4) * 90 }));
    expect(reportedPitches(smear).groups).toHaveLength(1);
    // A 12/12 roof whose opposed pairs read 13 % apart (the benchmark's ev-51883109): a step is a share of the pitch.
    const steep = [face(11.4, 40, { azimuthDeg: 0 }), face(11.5, 40, { azimuthDeg: 180 }), face(12.9, 40, { azimuthDeg: 90 }), face(13.0, 40, { azimuthDeg: 270 }), face(12.2, 80, { azimuthDeg: 0 }), face(12.3, 80, { azimuthDeg: 180 })];
    expect(reportedPitches(steep).groups).toHaveLength(1);
    // The pairs must look opposite ways: two neighbours on one side of a leaning roof agree too.
    expect(reportedPitches([face(5.0, 40, { azimuthDeg: 0 }), face(5.02, 40, { azimuthDeg: 40 }), face(5.98, 40, { azimuthDeg: 180 }), face(5.97, 40, { azimuthDeg: 220 })]).groups).toHaveLength(1);
    // Without facings nothing is told (callers that give none get the pooling as it was).
    expect(reportedPitches([face(5.0, 40), face(5.02, 40), face(5.98, 40), face(5.97, 40)]).groups).toHaveLength(1);
  });
});

describe('reportedPitches: a reading not taken on the calibrated height map', () => {
  const lidar = (pitchX12: number, areaM2: number) => face(pitchX12, areaM2, { uncalibrated: true });

  it('alone it reports its pitch as read, and its sloped area follows that pitch', () => {
    const faces = [face(6.2, 60), face(6.3, 60), lidar(9, 50), lidar(1, 30)];
    const { pitchX12, areaPitchX12 } = reportedPitches(faces, GOOGLE);
    expect(pitchX12[0]).toBeCloseTo(6.25 - 0.25, 9);
    expect(pitchX12[2]).toBe(9);
    expect(areaPitchX12[2]).toBe(9);
    expect(pitchX12[3]).toBe(1);
    // Before, and with the switch back: 0.25/12 off the lidar's pitch too.
    const before = reportedPitches(faces, { ...GOOGLE, offsetLidar: true }).pitchX12;
    expect(before[2]).toBeCloseTo(8.75, 9);
    expect(before[3]).toBeCloseTo(0.9, 9);
    expect(reportedPitches(faces.map((f) => ({ pitchX12: f.pitchX12, areaM2: f.areaM2 })), GOOGLE).pitchX12).toEqual(before);
  });

  it('lidar faces that agree report their own pooled pitch, with nothing taken off', () => {
    const { pitchX12, groups } = reportedPitches([lidar(6.0, 40), lidar(6.1, 40), face(9.2, 60), face(9.3, 60)], GOOGLE);
    expect(groups).toHaveLength(2);
    expect(pitchX12[0]).toBeCloseTo(6.05, 9);
    expect(pitchX12[1]).toBeCloseTo(6.05, 9);
    expect(pitchX12[2]).toBeCloseTo(9.0, 9);
  });

  it('in a group with the height map`s faces it neither drags their pitch down nor loses the offset twice', () => {
    // A 6/12 roof: Google's map reads two of its faces 6.25, the lidar reads the largest one 6.0.
    const faces = [face(6.25, 40), face(6.25, 40), lidar(6.0, 120)];
    for (const p of reportedPitches(faces, GOOGLE).pitchX12) expect(p).toBeCloseTo(6.0, 9);
    // Before: the lidar's true reading counted as a steep one, and every face came out under 6.
    for (const p of reportedPitches(faces, { ...GOOGLE, offsetLidar: true }).pitchX12) expect(p).toBeLessThan(5.99);
    // With no offset to take off, a lidar face is a face like any other.
    expect(reportedPitches(faces).pitchX12).toEqual(reportedPitches(faces.map((f) => ({ pitchX12: f.pitchX12, areaM2: f.areaM2 }))).pitchX12);
  });
});

describe('the pitch a reconstructed roof reports, round 3', () => {
  it('the two strips of a bowed slope read its chord; the faces and every line stay as they were', () => {
    for (const turnDeg of [17, 63]) {
      const syn = synthesize(BOWED_HIP, { trees: 0, turnDeg });
      const now = reconstructRoof(syn.raster, syn.point)!;
      const before = reconstructRoof(syn.raster, syn.point, { pitch: { stackChord: false } })!;
      // The bowed north side is two faces either way: a steep strip by the ridge over a shallow one by the eave.
      const north = (roof: LocalRoof) => roof.faces.filter((f) => Math.abs(((f.azimuthDeg - syn.azimuth(90) + 540) % 360) - 180) < 20);
      expect(north(now)).toHaveLength(2);
      expect(north(before).map((f) => f.pitchX12).sort((a, b) => a - b)[0]!).toBeLessThan(3.5);
      expect(north(before).map((f) => f.pitchX12).sort((a, b) => a - b)[1]!).toBeGreaterThan(8);
      // Now both report the slope's pitch (5/12), and so does the roof.
      for (const f of now.faces) expect(Math.abs(f.pitchX12 - 5), `turned ${turnDeg}: ${f.fitPitchX12} reports ${f.pitchX12}`).toBeLessThan(0.3);
      // The planes' own pitches are kept, and nothing else moved.
      expect(drawn(now)).toEqual(drawn(before));
      // The sloped area follows the pitch reported.
      for (const f of north(now)) expect(f.slopedAreaM2).toBeCloseTo(f.planAreaM2 * Math.hypot(1, f.pitchX12 / 12), 9);
    }
  });

  it('a real pitch break and a porch roof under a wall keep their two pitches', () => {
    for (const shape of [PITCH_BREAK, PORCH]) {
      const syn = synthesize(shape, { trees: 0 });
      const now = reconstructRoof(syn.raster, syn.point)!;
      expect(now.faces.map((f) => f.pitchX12)).toEqual(reconstructRoof(syn.raster, syn.point, { pitch: ROUND_2 })!.faces.map((f) => f.pitchX12));
      for (const truth of syn.faces) {
        const f = now.faces.find((x) => inside(syn.toLocal(truth.probe), x.ring))!;
        expect(Math.abs(f.pitchX12 - truth.pitchX12), `${shape.name}: ${truth.name}`).toBeLessThan(0.3);
      }
    }
  });

  it('a mirrored slope on a leaning height map does not repeat the lean in the roof`s pitch', () => {
    // An L-shaped cross gable at 6/12, a bowed slope on each gable, on a map that leans 0.48/12 across the main ridge:
    // the main gable's clean south slope reads 6.5, and its bowed north slope is mirrored from it.
    const syn = leaning(synthesize(BOWED_L, { trees: 0 }), 0.04);
    const now = reconstructRoof(syn.raster, syn.point)!;
    const before = reconstructRoof(syn.raster, syn.point, { pitch: { fittedVote: true } })!;
    expect(now.faces.filter((f) => f.fitted === 'gable')).toHaveLength(2);
    expect(drawn(now)).toEqual(drawn(before));
    const pitch = (roof: LocalRoof) => roof.faces[0]!.pitchX12;
    for (const f of now.faces) expect(f.pitchX12).toBe(pitch(now));
    expect(pitch(now)).toBeLessThan(pitch(before) - 0.05);
    expect(Math.abs(pitch(now) - 6)).toBeLessThan(Math.abs(pitch(before) - 6));
  });

  /** A cross gable: a main roof 16 x 8 m at `main`/12 (ridge along X) and a wing 8 m wide running 7 m out to the south at `wing`/12. */
  const cross = (main: number, wing: number): Shape => ({
    name: `cross gable at ${main}/12 with a wing at ${wing}/12`,
    extent: 13,
    height: ({ x, y }) => {
      const m = Math.abs(x) <= 8 && Math.abs(y) <= 4 ? (4 - Math.abs(y)) * (main / 12) : null;
      const w = Math.abs(x) <= 4 && y <= 0 && y >= -11 ? (4 - Math.abs(x)) * (wing / 12) : null;
      return m === null && w === null ? null : 3 + Math.max(m ?? -Infinity, w ?? -Infinity);
    },
    faces: [],
    lines: {},
    planAreaM2: 184,
  });

  it('a roof with a 5/12 part and a 6/12 part reports both, whichever is the main roof', () => {
    for (const [main, wing] of [[6, 5], [5, 6]] as const) {
      const syn = synthesize(cross(main, wing), { trees: 0 });
      const now = reconstructRoof(syn.raster, syn.point)!;
      const at = (roof: LocalRoof, p: XY) => roof.faces.find((f) => inside(syn.toLocal(p), f.ring))!;
      for (const p of [{ x: -6, y: 2 }, { x: 6, y: 2 }, { x: -6, y: -2 }]) expect(Math.abs(at(now, p).pitchX12 - main), `main roof at ${main}`).toBeLessThan(0.1);
      for (const p of [{ x: -2, y: -8 }, { x: 2, y: -8 }]) expect(Math.abs(at(now, p).pitchX12 - wing), `wing at ${wing}`).toBeLessThan(0.1);
      // Before: one pitch for the whole roof, or the wing's two slopes a step apart.
      const before = reconstructRoof(syn.raster, syn.point, { pitch: { stepShare: 0 } })!;
      const wingBefore = [at(before, { x: -2, y: -8 }).pitchX12, at(before, { x: 2, y: -8 }).pitchX12];
      expect(Math.max(...wingBefore.map((p) => Math.abs(p - wing)))).toBeGreaterThan(0.9);
      expect(drawn(now)).toEqual(drawn(before));
    }
    // One pitch all over stays one pitch.
    const same = synthesize(cross(6, 6), { trees: 0 });
    for (const f of reconstructRoof(same.raster, same.point)!.faces) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.1);
  });

  it('a face measured by lidar keeps its pitch when the height map`s calibration is taken off the others', () => {
    // The lidar-fusion duplex: Google sees one 7 x 6 m unit at 6/12; the twin east of it is under a crown in Google's
    // heights and the lidar's alone. Here the twin's roof is 9/12, so its two faces are a pitch of their own.
    const sc = scene({ seed: 70, turnDeg: 0, hx: 3, hy: 3, hideM: -10 });
    const s = sc.raster.pixelSizeM;
    const W = sc.raster.width;
    const inUnit = (p: XY) => p.x > 3 && p.x < 8.9 && Math.abs(p.y) < 3;
    const dsm = sc.raster.dsm.slice();
    for (let i = 0; i < dsm.length; i++) {
      const c = i % W;
      const p = sc.toHouse({ x: (c + 0.5) * s, y: -((i - c) / W + 0.5) * s });
      if (p.x > 3 && p.x < 9.5 && Math.abs(p.y) < 3.5) dsm[i] = 8 + 0.3 * Math.sin(c * 1.3);
    }
    const base = sc.cloud();
    const zs = Array.from(base.z);
    const fs = Array.from(base.flags);
    for (let k = 0; k < zs.length; k++) {
      const p = sc.toHouse({ x: base.x[k]! + 0.7, y: base.y[k]! - 0.4 });
      if (inUnit(p) && (fs[k]! & 2) === 2) {
        zs[k] = 3 + (3 - Math.abs(p.y)) * 0.75 - 31.2;
        fs[k] = 1;
      }
    }
    const cloud = { ...base, z: Float64Array.from(zs), flags: Uint8Array.from(fs) };
    const raster = { ...sc.raster, dsm };
    const run = (pitch: Partial<typeof DEFAULT_PITCH_PARAMS>) => reconstructRoof(raster, sc.point, { lidarFusion: { cloud }, pitch })!;
    const raw = run({ offsetX12: 0 });
    const now = run({ offsetX12: 0.25 });
    const before = run({ offsetX12: 0.25, offsetLidar: true });
    expect(now.lidarFusion?.applied).toBe(true);
    const twin = now.faces.map((f, k) => ({ f, k })).filter(({ f }) => f.source === 'lidar');
    const own = now.faces.map((f, k) => ({ f, k })).filter(({ f }) => f.source === undefined && !f.flat);
    expect(twin.length).toBeGreaterThanOrEqual(2);
    expect(own.length).toBeGreaterThanOrEqual(2);
    for (const { f, k } of twin) {
      // The lidar's pitch as read (pooled between the twin's faces), 9/12; before, 0.25/12 under it.
      expect(f.pitchX12).toBeCloseTo(raw.faces[k]!.pitchX12, 9);
      expect(Math.abs(f.pitchX12 - 9)).toBeLessThan(0.4);
      expect(before.faces[k]!.pitchX12).toBeCloseTo(raw.faces[k]!.pitchX12 - 0.25, 9);
      expect(f.slopedAreaM2).toBeCloseTo(raw.faces[k]!.slopedAreaM2, 9);
    }
    // Google's own faces lose the offset either way.
    for (const { f, k } of own) {
      expect(f.pitchX12).toBeCloseTo(raw.faces[k]!.pitchX12 - 0.25, 9);
      expect(before.faces[k]!.pitchX12).toBe(f.pitchX12);
    }
  });

  it('a narrow steep roof on a blurred height map already reads its pitch, and a wide 6/12 roof is not touched', () => {
    // The fixture's 5 x 5 box blur is 0.14 m (one sigma), what the benchmark's ridges show of Google's height maps.
    // A 12/12 gable 3 or 4 m across (slopes of 1.5 and 2 m run) and a small 12/12 hip read 12, not 10: the plane fit
    // keeps to the pixels on the plane and the rounded ridge falls outside it. Nothing here needed the round's changes.
    for (const shape of [gableShape(10, 3, 12), gableShape(10, 4, 12), hipShape(7, 6, 12)]) {
      const syn = synthesize(shape, { trees: 0 });
      const roof = reconstructRoof(syn.raster, syn.point)!;
      expect(roof.faces.length, shape.name).toBe(syn.faces.length);
      for (const f of roof.faces) {
        expect(Math.abs(f.fitPitchX12 - 12), `${shape.name}: fitted ${f.fitPitchX12}`).toBeLessThan(0.3);
        expect(Math.abs(f.pitchX12 - 12), `${shape.name}: reports ${f.pitchX12}`).toBeLessThan(0.15);
      }
      expect(roof.faces.map((f) => f.pitchX12)).toEqual(reconstructRoof(syn.raster, syn.point, { pitch: ROUND_2 })!.faces.map((f) => f.pitchX12));
    }
    const wide = synthesize(gableShape(12, 8, 6), { trees: 0 });
    const roof = reconstructRoof(wide.raster, wide.point)!;
    for (const f of roof.faces) expect(Math.abs(f.pitchX12 - 6)).toBeLessThan(0.05);
    expect(roof).toEqual(reconstructRoof(wide.raster, wide.point, { pitch: ROUND_2 }));
  });
});
