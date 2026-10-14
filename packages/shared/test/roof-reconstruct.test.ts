import { describe, expect, it } from 'vitest';
import {
  lngLatToUtm,
  reconstructRoof,
  type ReconstructOptions,
  toRoof3d,
  utmToLngLat,
  utmZoneOfEpsg,
  type LocalRoof,
} from '../src/roof-reconstruct/index.ts';
import { squareOutline } from '../src/roof-reconstruct/outline.ts';
import { joinCollinear, jogsFollow, type TopoLine } from '../src/roof-reconstruct/topology.ts';
import {
  GABLE,
  HIP,
  HIP_FLAT,
  L_CROSS,
  PORCH,
  SHAPES,
  synthesize,
  TERRACE,
  TERRACE_HOME,
  TWO_STOREY,
  type SyntheticRoof,
  type XY,
} from './fixtures/synthetic-roofs.ts';

function inside(p: XY, ring: readonly XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

function lengths(roof: LocalRoof): Record<string, number> {
  const by: Record<string, number> = {};
  for (const l of roof.lines) by[l.kind] = (by[l.kind] ?? 0) + l.lengthM;
  return by;
}

function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** Every check the reconstruction must pass against a synthetic roof's ground truth. */
function checkAgainstTruth(syn: SyntheticRoof, opts: ReconstructOptions = {}, areaTol = 0.01): LocalRoof {
  const roof = reconstructRoof(syn.raster, syn.point, opts);
  expect(roof, syn.name).not.toBeNull();
  const r = roof!;
  // The faces: one per true face, each with its pitch (within 0.5/12), facing and plan area (within 5%).
  expect(r.faces.length, `${syn.name}: face count`).toBe(syn.faces.length);
  for (const truth of syn.faces) {
    const face = r.faces.find((f) => inside(syn.toLocal(truth.probe), f.ring));
    expect(face, `${syn.name}: ${truth.name} found`).toBeDefined();
    expect(Math.abs(face!.pitchX12 - truth.pitchX12), `${syn.name}: ${truth.name} pitch`).toBeLessThan(0.5);
    expect(face!.flat, `${syn.name}: ${truth.name} flat`).toBe(truth.flat === true);
    if (truth.flat !== true) expect(arc(face!.azimuthDeg, syn.azimuth(truth.downDeg)), `${syn.name}: ${truth.name} facing`).toBeLessThan(3);
    expect(Math.abs(face!.planAreaM2 / truth.planAreaM2 - 1), `${syn.name}: ${truth.name} area`).toBeLessThan(0.05);
  }
  // No face under the minimum plane size.
  for (const f of r.faces) expect(f.planAreaM2).toBeGreaterThanOrEqual(2);
  expect(Math.abs(r.faces.reduce((t, f) => t + f.planAreaM2, 0) / syn.planAreaM2 - 1)).toBeLessThan(areaTol);
  // The lines: each kind's true length within 5%, and no kind the roof does not have (eaves stay eaves, rakes rakes).
  const got = lengths(r);
  for (const [kind, want] of Object.entries(syn.lines)) {
    expect(Math.abs((got[kind] ?? 0) / want - 1), `${syn.name}: ${kind} length ${got[kind]} vs ${want}`).toBeLessThan(0.05);
  }
  for (const [kind, len] of Object.entries(got)) {
    if (!(kind in syn.lines)) expect(len, `${syn.name}: no ${kind}`).toBeLessThan(0.5);
  }
  return r;
}

/** Google's box round a footprint (house frame) as it comes: north-up in the raster, 0.3 m round it, in pixels. */
function boxOf(syn: SyntheticRoof, footprint: readonly XY[]): { col: number; row: number }[] {
  const s = syn.raster.pixelSizeM;
  const pts = footprint.map((p) => syn.toLocal(p));
  const c0 = (Math.min(...pts.map((p) => p.x)) - 0.3) / s;
  const c1 = (Math.max(...pts.map((p) => p.x)) + 0.3) / s;
  const r0 = -(Math.max(...pts.map((p) => p.y)) + 0.3) / s;
  const r1 = -(Math.min(...pts.map((p) => p.y)) - 0.3) / s;
  return [
    { col: c0, row: r0 },
    { col: c1, row: r0 },
    { col: c1, row: r1 },
    { col: c0, row: r1 },
  ];
}

describe('reconstructRoof on synthetic height maps', () => {
  for (const shape of SHAPES) {
    it(`${shape.name}: faces, pitches, areas and lines match the ground truth`, () => {
      checkAgainstTruth(synthesize(shape, { turnDeg: 17, seed: 11 }));
    });
    it(`${shape.name}: the same at 45 degrees with other trees`, () => {
      checkAgainstTruth(synthesize(shape, { turnDeg: 45, seed: 5 }));
    });
  }

  it('a tree crown overhanging the roof: no steep sliver, the faces and lines as they are, the tree share reported', () => {
    // A broad crown 3 m above the hip roof, over its north eave (house frame 2, 4: 1 m in from the eave).
    for (const turnDeg of [17, 45]) {
      const syn = synthesize(HIP, { turnDeg, seed: 3, trees: 0, overhangAt: { x: 2, y: 4 } });
      checkAgainstTruth(syn);
      const roof = reconstructRoof(syn.raster, syn.point, { imageryQuality: 'HIGH' })!;
      expect(roof.quality.treeShare).toBeGreaterThan(0.02);
      expect(roof.faces.every((f) => f.pitchX12 < 8)).toBe(true);
    }
    // Without the photo (no green), the crown is still not a face.
    const bare = synthesize(HIP, { turnDeg: 17, seed: 3, trees: 0, overhangAt: { x: 2, y: 4 } });
    checkAgainstTruth({ ...bare, raster: { ...bare.raster, green: null } });
  });

  it('reports its quality: a clean roof needs no review, coarse imagery does', () => {
    const syn = synthesize(GABLE, { turnDeg: 17 });
    const clean = reconstructRoof(syn.raster, syn.point, { imageryQuality: 'HIGH' })!.quality;
    expect(clean.reasons).toEqual([]);
    expect(clean.outlineIoU).toBeGreaterThan(0.97);
    expect(clean.edgeFit).toBe(1);
    expect(clean.faceCoverage).toBeGreaterThan(0.97);
    expect(clean.meanResidualM).toBeLessThan(0.1);
    expect(reconstructRoof(syn.raster, syn.point, { imageryQuality: 'MEDIUM' })!.quality.reasons).toEqual(['coarse-imagery']);
  });

  it('classifies the gable: two eaves along the ridge, four rakes up the ends', () => {
    const roof = reconstructRoof(...args(synthesize(GABLE, { turnDeg: 30 })))!;
    const eaves = roof.lines.filter((l) => l.kind === 'eave');
    const rakes = roof.lines.filter((l) => l.kind === 'rake');
    expect(eaves).toHaveLength(2);
    expect(rakes).toHaveLength(4);
    for (const e of eaves) expect(e.riseM).toBeLessThan(0.1);
    for (const r of rakes) expect(r.riseM).toBeGreaterThan(2);
  });

  it('meets the hips at the ridge ends and the outline corners', () => {
    const syn = synthesize(HIP, { turnDeg: 17 });
    const roof = reconstructRoof(syn.raster, syn.point)!;
    const ridge = roof.lines.find((l) => l.kind === 'ridge')!;
    const hips = roof.lines.filter((l) => l.kind === 'hip');
    expect(hips).toHaveLength(4);
    // Each hip runs from a ridge end to an outline corner: its ends are shared exactly.
    const corners = roof.outline;
    for (const h of hips) {
      const ends = [h.a, h.b];
      expect(ends.some((p) => [ridge.a, ridge.b].some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9))).toBe(true);
      expect(ends.some((p) => corners.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 1e-9))).toBe(true);
    }
  });

  it('draws valleys where the L wing meets the main roof, and flashing only at the upper storey', () => {
    const l = reconstructRoof(...args(synthesize(L_CROSS, { turnDeg: 17 })))!;
    expect(l.lines.filter((x) => x.kind === 'valley')).toHaveLength(2);
    expect(l.lines.some((x) => x.kind === 'flashing' || x.kind === 'step-flashing')).toBe(false);
    const syn = synthesize(TWO_STOREY, { turnDeg: 17 });
    const two = reconstructRoof(...args(syn))!;
    const faceAt = (p: XY) => two.faces.findIndex((f) => inside(syn.toLocal(p), f.ring));
    const upper = [faceAt({ x: -5.5, y: 2.5 }), faceAt({ x: -5.5, y: -2.5 })];
    const lower = [faceAt({ x: 4.5, y: 2.5 }), faceAt({ x: 4.5, y: -2.5 })];
    // The wall: step flashing on each lower face up its slope, one face each; the upper faces' edges over it are rakes.
    const flashing = two.lines.filter((x) => x.kind === 'step-flashing');
    expect(flashing.length).toBeGreaterThanOrEqual(2);
    for (const s of flashing) expect(s.faces.length === 1 && lower.includes(s.faces[0]!)).toBe(true);
    const w0 = syn.toLocal({ x: -1, y: -5 });
    const w1 = syn.toLocal({ x: -1, y: 5 });
    const offWall = (p: XY) => Math.abs((w1.x - w0.x) * (p.y - w0.y) - (w1.y - w0.y) * (p.x - w0.x)) / Math.hypot(w1.x - w0.x, w1.y - w0.y);
    const nearWall = (x: { a: XY; b: XY }) => offWall(x.a) < 0.3 && offWall(x.b) < 0.3;
    const upperRakes = two.lines.filter((x) => x.kind === 'rake' && nearWall(x));
    expect(upperRakes.length).toBeGreaterThanOrEqual(2);
    for (const r of upperRakes) expect(upper).toContain(r.faces[0]);
  });

  it('counts an upper eave over a porch roof as an eave, and flashes the porch roof along the wall', () => {
    // Turns and trees where the porch's corners land true (where a tree sits on the wall's end the corner can be placed
    // off it, which moves areas and lines alike).
    for (const [turnDeg, seed] of [[17, 11], [30, 7], [30, 11]] as const) checkAgainstTruth(synthesize(PORCH, { turnDeg, seed }));
  });

  it('counts a jog in an eave as eave, and a short piece between two kinds as itself', () => {
    const line = (kind: TopoLine['kind'], a: XY, b: XY, face = 0): TopoLine => ({ kind, a, b, faces: [face], lengthM: Math.hypot(b.x - a.x, b.y - a.y), riseM: 0 });
    const eaveJog = [line('eave', { x: 0, y: 0 }, { x: 6, y: 0 }), line('rake', { x: 6, y: 0 }, { x: 6, y: -0.8 }), line('eave', { x: 6, y: -0.8 }, { x: 12, y: -0.8 })];
    expect(jogsFollow(eaveJog, 1.5).map((l) => l.kind)).toEqual(['eave', 'eave', 'eave']);
    // A gable: eave, rake up, rake down, eave: nothing between two of one kind.
    const gable = [line('eave', { x: 0, y: 0 }, { x: 6, y: 0 }), line('rake', { x: 6, y: 0 }, { x: 6, y: 1 }), line('eave', { x: 6, y: 1 }, { x: 0, y: 1 }, 1)];
    expect(jogsFollow(gable, 1.5).map((l) => l.kind)).toEqual(['eave', 'rake', 'eave']);
    // A long piece is its own kind, however it sits.
    const long = [eaveJog[0]!, line('rake', { x: 6, y: 0 }, { x: 6, y: -3 }), line('eave', { x: 6, y: -3 }, { x: 12, y: -3 })];
    expect(jogsFollow(long, 1.5).map((l) => l.kind)).toEqual(['eave', 'rake', 'eave']);
  });

  it('joins pieces of one line running on in a straight line, and only those', () => {
    const ridge = (a: XY, b: XY, faces = [0, 1]): TopoLine => ({ kind: 'ridge', a, b, faces, lengthM: Math.hypot(b.x - a.x, b.y - a.y), riseM: 0 });
    const joined = joinCollinear([ridge({ x: 0, y: 0 }, { x: 4, y: 0 }), ridge({ x: 7, y: 0 }, { x: 4, y: 0 }), ridge({ x: 7, y: 0 }, { x: 9, y: 2 })]);
    expect(joined).toHaveLength(2);
    expect(joined[0]!.lengthM).toBeCloseTo(7, 9);
    // Other faces: not the same line.
    expect(joinCollinear([ridge({ x: 0, y: 0 }, { x: 4, y: 0 }), ridge({ x: 4, y: 0 }, { x: 7, y: 0 }, [1, 2])])).toHaveLength(2);
  });

  it('marks the flat deck of a hip roof flat, with ridges round it where the hip faces meet it', () => {
    const roof = reconstructRoof(...args(synthesize(HIP_FLAT, { turnDeg: 17 })))!;
    const flat = roof.faces.filter((f) => f.flat);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.pitchX12).toBeLessThan(0.5);
    const deck = roof.faces.indexOf(flat[0]!);
    const ridges = roof.lines.filter((x) => x.kind === 'ridge');
    expect(ridges).toHaveLength(4);
    for (const r of ridges) expect(r.faces).toContain(deck);
    expect(roof.lines.some((x) => x.kind === 'flat-edge')).toBe(false);
  });

  it('is deterministic: the same height map gives the same roof', () => {
    const syn = synthesize(L_CROSS, { turnDeg: 23 });
    expect(JSON.stringify(reconstructRoof(syn.raster, syn.point))).toBe(JSON.stringify(reconstructRoof(syn.raster, syn.point)));
  });

  it('finds no roof when the point is far from any roof, or the roof is tiny', () => {
    const syn = synthesize(GABLE);
    expect(reconstructRoof(syn.raster, { col: 2, row: 2 }, { maxPointDistM: 3 })).toBeNull();
    const tiny = { ...syn.raster, mask: new Uint8Array(syn.raster.mask.length) };
    tiny.mask[Math.floor(syn.point.row) * syn.raster.width + Math.floor(syn.point.col)] = 1;
    expect(reconstructRoof(tiny, syn.point)).toBeNull();
  });
});

function args(syn: SyntheticRoof): [SyntheticRoof['raster'], SyntheticRoof['point']] {
  return [syn.raster, syn.point];
}

describe('reconstructRoof on a terrace (the mask joins the homes)', () => {
  it("with Google's box for the home at the point: that home alone, marked for review", () => {
    for (const turnDeg of [0, 17, 45]) {
      const syn = synthesize(TERRACE, { turnDeg, seed: 11 });
      // Within 5% of the home's area: the step at each party wall is blurred over a few pixels in the heights.
      const r = checkAgainstTruth(syn, { building: boxOf(syn, TERRACE_HOME) }, 0.05);
      expect(r.quality.reasons, `turned ${turnDeg}`).toContain('joined-buildings');
      expect(r.clipped).toBe(false);
    }
  });
  it('without the box: the whole terrace, not marked joined', () => {
    const syn = synthesize(TERRACE, { turnDeg: 17, seed: 11 });
    const r = reconstructRoof(syn.raster, syn.point)!;
    expect(Math.abs(r.faces.reduce((t, f) => t + f.planAreaM2, 0) / 210 - 1)).toBeLessThan(0.02);
    expect(r.quality.reasons).not.toContain('joined-buildings');
  });
  it("a detached house inside its box is not touched by it", () => {
    const syn = synthesize(HIP, { turnDeg: 17, seed: 11 });
    const footprint = [
      { x: -8, y: -5 },
      { x: 8, y: -5 },
      { x: 8, y: 5 },
      { x: -8, y: 5 },
    ];
    const plain = reconstructRoof(syn.raster, syn.point)!;
    const boxed = checkAgainstTruth(syn, { building: boxOf(syn, footprint) });
    expect(boxed.faces.map((f) => f.planAreaM2)).toEqual(plain.faces.map((f) => f.planAreaM2));
    expect(boxed.quality.reasons).not.toContain('joined-buildings');
  });
});

describe('squareOutline', () => {
  it('squares a noisy, clipped rectangle to its four corners', () => {
    // A 12 x 8 m rectangle turned 20 degrees, its boundary jittered by 10 cm, one corner clipped by a metre.
    const turn = (20 * Math.PI) / 180;
    const pts: XY[] = [];
    const add = (x: number, y: number, k: number) => pts.push({ x: x * Math.cos(turn) - y * Math.sin(turn) + 0.1 * Math.sin(k * 1.7), y: x * Math.sin(turn) + y * Math.cos(turn) + 0.1 * Math.cos(k * 2.3) });
    let k = 0;
    for (let x = 0; x <= 11; x += 0.25) add(x, 0, k++);
    for (let y = 1; y <= 8; y += 0.25) add(12, y, k++);
    for (let x = 12; x >= 0; x -= 0.25) add(x, 8, k++);
    for (let y = 8; y > 0; y -= 0.25) add(0, y, k++);
    const ring = squareOutline(pts);
    expect(ring).toHaveLength(4);
    const area = Math.abs(ring.reduce((t, p, i) => t + p.x * ring[(i + 1) % 4]!.y - ring[(i + 1) % 4]!.x * p.y, 0)) / 2;
    expect(area).toBeGreaterThan(94);
    expect(area).toBeLessThan(98);
    // Right angles.
    for (let i = 0; i < 4; i++) {
      const a = ring[i]!;
      const b = ring[(i + 1) % 4]!;
      const c = ring[(i + 2) % 4]!;
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      expect(Math.abs(dot)).toBeLessThan(1e-6);
    }
  });
});

describe('UTM', () => {
  it('matches PROJ to the millimetre, both ways', () => {
    const cases: [number, number, number, number, number][] = [
      [-92.311074, 34.753229, 32615, 563054.3238, 3845893.7556],
      [-117.7723202, 33.7400499, 32611, 428460.547, 3733601.6486],
      [-96.0243555, 41.1721737, 32614, 749619.0536, 4562139.5517],
      [151.2093, -33.8688, 32756, 334368.6336, 6250948.3454],
    ];
    for (const [lng, lat, epsg, e, n] of cases) {
      const zone = utmZoneOfEpsg(epsg)!;
      const fwd = lngLatToUtm(zone, lng, lat);
      expect(Math.abs(fwd.easting - e)).toBeLessThan(0.002);
      expect(Math.abs(fwd.northing - n)).toBeLessThan(0.002);
      const [lng2, lat2] = utmToLngLat(zone, e, n);
      expect(Math.abs(lng2 - lng)).toBeLessThan(1e-8);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-8);
    }
    expect(utmZoneOfEpsg(4326)).toBeNull();
  });
});

describe('toRoof3d', () => {
  it('stores [lng, lat], square feet and feet, faces largest first', () => {
    const syn = synthesize(HIP, { turnDeg: 17 });
    const local = reconstructRoof(syn.raster, syn.point)!;
    // One metre is 1e-5 degrees here: easy to check.
    const roof = toRoof3d(local, (x, y) => [-96 + x * 1e-5, 41 + y * 1e-5], { imageryQuality: 'HIGH', imageryDate: '2024-05-01' });
    expect(roof.version).toBe(1);
    expect(roof.faces).toHaveLength(4);
    const areas = roof.faces.map((f) => f.planAreaSqFt);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    expect(areas.reduce((t, a) => t + a, 0)).toBeCloseTo(160 * 10.7639, -1);
    expect(roof.faces[0]!.slopedAreaSqFt / roof.faces[0]!.planAreaSqFt).toBeCloseTo(Math.sqrt(1 + (5 / 12) ** 2), 2);
    const ridge = roof.lines.find((l) => l.kind === 'ridge')!;
    expect(ridge.lengthFt).toBeCloseTo(6 * 3.28084, 0);
    expect(roof.outline[0]![0]).toBeGreaterThan(-96);
    expect(roof.imageryQuality).toBe('HIGH');
  });
});
