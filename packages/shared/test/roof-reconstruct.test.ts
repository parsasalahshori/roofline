import { describe, expect, it } from 'vitest';
import { lngLatToUtm, reconstructRoof, toRoof3d, utmToLngLat, utmZoneOfEpsg, type LocalRoof } from '../src/roof-reconstruct/index.ts';
import { squareOutline } from '../src/roof-reconstruct/outline.ts';
import { GABLE, HIP, HIP_FLAT, L_CROSS, SHAPES, synthesize, TWO_STOREY, type SyntheticRoof, type XY } from './fixtures/synthetic-roofs.ts';

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
function checkAgainstTruth(syn: SyntheticRoof): void {
  const roof = reconstructRoof(syn.raster, syn.point);
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
  expect(Math.abs(r.faces.reduce((t, f) => t + f.planAreaM2, 0) / syn.planAreaM2 - 1)).toBeLessThan(0.01);
  // The lines: each kind's true length within 5%, and no kind the roof does not have (eaves stay eaves, rakes rakes).
  const got = lengths(r);
  for (const [kind, want] of Object.entries(syn.lines)) {
    expect(Math.abs((got[kind] ?? 0) / want - 1), `${syn.name}: ${kind} length ${got[kind]} vs ${want}`).toBeLessThan(0.05);
  }
  for (const [kind, len] of Object.entries(got)) {
    if (!(kind in syn.lines)) expect(len, `${syn.name}: no ${kind}`).toBeLessThan(0.5);
  }
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

  it('draws valleys where the L wing meets the main roof, and steps only at the upper storey', () => {
    const l = reconstructRoof(...args(synthesize(L_CROSS, { turnDeg: 17 })))!;
    expect(l.lines.filter((x) => x.kind === 'valley')).toHaveLength(2);
    expect(l.lines.some((x) => x.kind === 'step')).toBe(false);
    const two = reconstructRoof(...args(synthesize(TWO_STOREY, { turnDeg: 17 })))!;
    const steps = two.lines.filter((x) => x.kind === 'step');
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const s of steps) expect(s.faces).toHaveLength(2);
  });

  it('marks the flat deck of a hip roof flat, with flat edges round it', () => {
    const roof = reconstructRoof(...args(synthesize(HIP_FLAT, { turnDeg: 17 })))!;
    const flat = roof.faces.filter((f) => f.flat);
    expect(flat).toHaveLength(1);
    expect(flat[0]!.pitchX12).toBeLessThan(0.5);
    expect(roof.lines.filter((x) => x.kind === 'flat-edge')).toHaveLength(4);
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
