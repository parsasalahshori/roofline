import { describe, expect, it } from 'vitest';
import { isRoof3d, type Roof3d, roof3dSnapshotFresh, roofPlanesFrom3d, sameOutline } from '../src/roof-3d.ts';
import { measureRoof, roofModelFrom3d } from '../src/roof-model.ts';
import { polygonAreaSqFt, type Ring } from '../src/roof.ts';
import { reconstructRoof, toRoof3d } from '../src/roof-reconstruct/index.ts';
import { HIP, HIP_FLAT, synthesize, TWO_STOREY } from './fixtures/synthetic-roofs.ts';

// Omaha; raster-local metres to [lng, lat] with the same sphere the engine uses.
const LNG0 = -96.0;
const LAT0 = 41.25;
const K = (Math.PI / 180) * 6371008.8;
const COS = Math.cos((LAT0 * Math.PI) / 180);
const toLngLat = (x: number, y: number): [number, number] => [LNG0 + x / (K * COS), LAT0 + y / K];

function roofOf(shape = HIP, turnDeg = 17): Roof3d {
  const syn = synthesize(shape, { turnDeg });
  return toRoof3d(reconstructRoof(syn.raster, syn.point)!, toLngLat, { imageryQuality: 'HIGH', imageryDate: '2024-05-01' });
}

const HIP_ROOF = roofOf();

describe('roofModelFrom3d', () => {
  it("is the reconstruction's faces and lines: letters largest first, whole-number pitch labels, measured areas", () => {
    const m = roofModelFrom3d(HIP_ROOF, { pitchX12: 5, ownPitch: true });
    expect(m.facets.map((f) => f.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(m.facets.map((f) => f.pitch)).toEqual(['5/12', '5/12', '5/12', '5/12']);
    for (let i = 0; i < 4; i++) {
      expect(m.facets[i]!.planSqFt).toBeCloseTo(HIP_ROOF.faces[i]!.planAreaSqFt, 1);
      expect(m.facets[i]!.areaSqFt).toBeCloseTo(HIP_ROOF.faces[i]!.slopedAreaSqFt, 1);
      expect(m.facets[i]!.ring[0]).toEqual(m.facets[i]!.ring.at(-1));
    }
    expect(m.totals.facetCount).toBe(4);
    expect(m.totals.hipFt).toBeCloseTo(29.5 * 3.28084, -1);
    expect(m.totals.ridgeFt).toBeCloseTo(6 * 3.28084, 0);
    expect(m.totals.rakeFt).toBe(0);
    expect(m.totals.stepFt).toBe(0);
    expect(m.totals.wastePct).toBeGreaterThan(10);
    // Every line names the facets it borders: one for an eave, two for a hip or ridge.
    for (const l of m.lines) expect(l.facets).toHaveLength(l.kind === 'eave' ? 1 : 2);
  });

  it('a pitch picked by hand is every sloped face\'s: areas and the hips follow, the eaves and the plan do not', () => {
    const own = roofModelFrom3d(HIP_ROOF, { pitchX12: 5, ownPitch: true });
    const steep = roofModelFrom3d(HIP_ROOF, { pitchX12: 10, ownPitch: false });
    expect(steep.facets.map((f) => f.pitch)).toEqual(['10/12', '10/12', '10/12', '10/12']);
    expect(steep.totals.planSqFt).toBeCloseTo(own.totals.planSqFt, 0);
    expect(steep.totals.slopedSqFt / steep.totals.planSqFt).toBeCloseTo(Math.sqrt(1 + (10 / 12) ** 2), 2);
    expect(steep.totals.eaveFt).toBeCloseTo(own.totals.eaveFt, 0);
    expect(steep.totals.ridgeFt).toBeCloseTo(own.totals.ridgeFt, 0);
    // A hip on a 10/12 hip roof 10 m wide: 5 m by 5 m in plan, rising 4.17 m.
    const hip = Math.sqrt(50 + (5 * (10 / 12)) ** 2) * 3.28084;
    expect(steep.totals.hipFt / 4).toBeCloseTo(hip, 0);
  });

  it('keeps flat faces flat whatever pitch is picked, and counts their edges', () => {
    const roof = roofOf(HIP_FLAT);
    const m = roofModelFrom3d(roof, { pitchX12: 9, ownPitch: false });
    const flat = roof.faces.findIndex((f) => f.flat);
    expect(m.facets[flat]!.pitch).toBe('0/12');
    expect(m.facets[flat]!.areaSqFt).toBeCloseTo(roof.faces[flat]!.planAreaSqFt, 0);
    // The deck's edges, where the hip faces meet it level, are ridges.
    expect(m.totals.ridgeFt).toBeCloseTo(28 * 3.28084, -1);
    expect(m.totals.flatEdgeFt).toBe(0);
  });

  it('counts the flashing where a lower roof meets an upper storey, and reads an older step as step flashing', () => {
    const roof = roofOf(TWO_STOREY);
    const m = roofModelFrom3d(roof, { pitchX12: 5, ownPitch: true });
    // Up the lower roof's 5/12 slope on both sides of the wall; none level along it.
    expect(m.totals.stepFt).toBeCloseTo(2 * Math.hypot(5, 5 * (5 / 12)) * 3.28084, -1);
    expect(m.totals.flashingFt).toBe(0);
    // The upper roof's edges over the lower one are rakes, counted with its gable's.
    expect(m.totals.rakeFt).toBeCloseTo((4 * Math.hypot(5, 5 * (8 / 12)) + 2 * Math.hypot(5, 5 * (5 / 12))) * 3.28084, -1);
    const old: Roof3d = { ...roof, lines: roof.lines.map((l) => (l.kind === 'step-flashing' ? { ...l, kind: 'step' as const } : l)) };
    expect(isRoof3d(old)).toBe(true);
    expect(roofModelFrom3d(old, { pitchX12: 5, ownPitch: true }).totals.stepFt).toBe(m.totals.stepFt);
  });
});

describe('measureRoof with a 3D roof', () => {
  const outline: Ring[] = [HIP_ROOF.outline];

  it('uses the reconstruction while the outline is its own: no overhang added, edges are its eaves and rakes', () => {
    const { estimate, roof } = measureRoof({ outline, pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true } });
    expect(roof!.facets).toHaveLength(4);
    expect(estimate.planSqFt).toBeCloseTo(HIP_ROOF.faces.reduce((t, f) => t + f.planAreaSqFt, 0), 0);
    expect(estimate.surfaceSqFt).toBeCloseTo(HIP_ROOF.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0), 0);
    expect(estimate.footprintSqFt).toBeCloseTo(polygonAreaSqFt(HIP_ROOF.outline), 0);
    expect(estimate.edgeFt).toBe(roof!.totals.eaveFt);
    expect(estimate.ridgeFt).toBe(roof!.totals.ridgeFt);
    expect(estimate.pitchX12).toBe(5);
    expect(roof!.totals.slopedSqFt).toBe(estimate.surfaceSqFt);
  });

  it('a closed or rotated copy of its outline is still its own; a moved outline is not', () => {
    const closed = [...HIP_ROOF.outline, HIP_ROOF.outline[0]!];
    const rotated = [...HIP_ROOF.outline.slice(2), ...HIP_ROOF.outline.slice(0, 2)];
    expect(sameOutline(closed, HIP_ROOF)).toBe(true);
    expect(sameOutline(rotated, HIP_ROOF)).toBe(true);
    const moved = HIP_ROOF.outline.map(([lng, lat]): [number, number] => [lng + 1e-5, lat]);
    expect(sameOutline(moved, HIP_ROOF)).toBe(false);
    const guessed = measureRoof({ outline: [moved], pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true } });
    expect(guessed).toEqual(measureRoof({ outline: [moved], pitchX12: 5, overhangFt: 1 }));
  });

  it('quotes only some faces of the reconstruction', () => {
    const whole = measureRoof({ outline, pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true } });
    const part = measureRoof({ outline, pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true }, excludedFacets: ['D'] });
    expect(part.roof!.excluded).toEqual(['D']);
    expect(part.roof!.quoted!.facetCount).toBe(3);
    expect(part.estimate.surfaceSqFt).toBeCloseTo(whole.estimate.surfaceSqFt - whole.roof!.facets[3]!.areaSqFt, -1);
  });

  it('adds other buildings worked out from their outlines, lettering every facet again largest first', () => {
    const shed: Ring = [
      [LNG0 + 0.001, LAT0],
      [LNG0 + 0.00106, LAT0],
      [LNG0 + 0.00106, LAT0 + 0.00004],
      [LNG0 + 0.001, LAT0 + 0.00004],
    ];
    const both = measureRoof({ outline: [...outline, shed], pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true } });
    const alone = measureRoof({ outline: [shed], pitchX12: 5, overhangFt: 1 });
    const recon = measureRoof({ outline, pitchX12: 5, overhangFt: 1, roof3d: { roof: HIP_ROOF, ownPitch: true } });
    expect(both.roof!.facets.length).toBe(recon.roof!.facets.length + alone.roof!.facets.length);
    expect(both.roof!.facets.map((f) => f.id)).toEqual('ABCDEFGHIJ'.slice(0, both.roof!.facets.length).split(''));
    const areas = both.roof!.facets.map((f) => f.planSqFt);
    expect([...areas].sort((a, b) => b - a)).toEqual(areas);
    expect(both.estimate.surfaceSqFt).toBeCloseTo(recon.estimate.surfaceSqFt + alone.estimate.surfaceSqFt, 0);
  });
});

describe('the stored 3D roof', () => {
  it('is checked before use', () => {
    expect(isRoof3d(HIP_ROOF)).toBe(true);
    expect(isRoof3d(null)).toBe(false);
    expect(isRoof3d({ ...HIP_ROOF, version: 2 })).toBe(false);
    expect(isRoof3d({ ...HIP_ROOF, faces: [] })).toBe(false);
  });

  it('is fresh for 30 days, for a point on the roof or within 3 m of where it was asked; "no imagery" covers 50 m', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const at = HIP_ROOF.faces[0]!.labelAt;
    const kept = { fetchedAt: '2026-10-01T12:00:00Z', at, roof: HIP_ROOF };
    expect(roof3dSnapshotFresh(kept, at, now)).toBe(true);
    expect(roof3dSnapshotFresh(kept, HIP_ROOF.faces[1]!.labelAt, now)).toBe(true);
    expect(roof3dSnapshotFresh(kept, [at[0] + 0.001, at[1]], now)).toBe(false);
    expect(roof3dSnapshotFresh({ ...kept, fetchedAt: '2026-09-01T12:00:00Z' }, at, now)).toBe(false);
    const none = { fetchedAt: '2026-10-01T12:00:00Z', at, roof: null, none: 'no-imagery' as const };
    expect(roof3dSnapshotFresh(none, [at[0] + 0.0004, at[1]], now)).toBe(true);
    expect(roof3dSnapshotFresh(none, [at[0] + 0.001, at[1]], now)).toBe(false);
    expect(roof3dSnapshotFresh({ ...none, none: 'no-roof' }, [at[0] + 0.0004, at[1]], now)).toBe(false);
  });

  it('gives its faces as measured planes for an outline drawn over it', () => {
    const planes = roofPlanesFrom3d(HIP_ROOF);
    expect(planes).toHaveLength(4);
    for (const p of planes) expect(p.pitchX12).toBe(5);
  });
});
