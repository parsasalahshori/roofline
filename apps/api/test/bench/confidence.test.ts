import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isRoof3d, type LngLat, needsReview, ROOF_QUALITY_REASONS, ROOF_QUALITY_SEVERITY, type Roof3d, type Roof3dSnapshot, type RoofQuality, roof3dSnapshotFresh, roof3dSnapshotStamp, roof3dSnapshotVersion } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { EDGE_AGREEMENT, edgeConfidence, EDGES_UNVERIFIED_SHARE, roofOnLayers, withEdgeEvidence } from '../../src/estimator/roof-3d.ts';
import { checkRoof, DIFFERS_AREA_SHARE, DIFFERS_STAKE_SHARE, differingShare, differingStake, formatCheck, tierReasons, withFaceConfidence, withGoogleCheck } from '../../src/estimator/roof-3d-compare.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';

/*
 * The confidence track (docs/roof-3d/confidence.md): the outline's eave evidence on the stored roof, the review reasons
 * sorted by severity, face confidence, and snapshots stored before any of it still reading. No database: these run in
 * the roof-bench project.
 */

/** A house about 25 m by 22 m with a 6/12 hip roof (the measurements test's). */
const HOUSE: LngLat[] = [
  [-96.0, 41.25],
  [-95.9997, 41.25],
  [-95.9997, 41.2502],
  [-96.0, 41.2502],
  [-96.0, 41.25],
];
const INSIDE: LngLat = [-95.99985, 41.2501];

/** The layers with a 7 m tall tree crown standing against the roof's east eave along its whole length. */
function treeOnEast(layers: RoofLayers, northHalfOnly = false): RoofLayers {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const east = lngLatToUtm(zone, -95.9997, 41.2501).easting - layers.originX;
  const { width, height, pixelSizeM: s } = layers.raster;
  const dsm = Float32Array.from(layers.raster.dsm);
  const rgb = Uint8Array.from(layers.photo!.rgb);
  const south = layers.originY - lngLatToUtm(zone, -95.9997, 41.25).northing;
  const north = layers.originY - lngLatToUtm(zone, -95.9997, 41.2502).northing;
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const x = (c + 0.5) * s;
      const y = (r + 0.5) * s;
      // Outside the roof only (the mask is untouched): from the eave to 4 m east, the roof's length plus a metre.
      if (x < east + 0.05 || x > east + 4 || y < north - 1 || y > (northHalfOnly ? (north + south) / 2 : south + 1)) continue;
      // Rough foliage: 7 m with 30 cm of texture, and green in the photo.
      dsm[r * width + c] = 7 + (((r * 7 + c * 13) % 7) - 3) * 0.1;
      rgb.set([60, 130, 50], (r * width + c) * 3);
    }
  }
  return { ...layers, raster: { ...layers.raster, dsm }, photo: { ...layers.photo!, rgb } };
}

/** A long house, about 40 m east-west by 14 m north-south. */
const LONG: LngLat[] = [
  [-96.0, 41.25],
  [-95.99952, 41.25],
  [-95.99952, 41.250126],
  [-96.0, 41.250126],
  [-96.0, 41.25],
];
const LONG_INSIDE: LngLat = [-95.99976, 41.250063];

/** A rough, green tree crown 7 m tall from one side's eave to 4 m out, along that whole side (mask untouched). */
function crownOn(layers: RoofLayers, ring: readonly LngLat[], side: 'south' | 'east'): RoofLayers {
  const zone = utmZoneOfEpsg(layers.epsg)!;
  const lng1 = Math.max(...ring.map((p) => p[0]));
  const lng0 = Math.min(...ring.map((p) => p[0]));
  const lat0 = Math.min(...ring.map((p) => p[1]));
  const lat1 = Math.max(...ring.map((p) => p[1]));
  const sw = lngLatToUtm(zone, lng0, lat0);
  const ne = lngLatToUtm(zone, lng1, lat1);
  const { width, height, pixelSizeM: s } = layers.raster;
  const dsm = Float32Array.from(layers.raster.dsm);
  const rgb = Uint8Array.from(layers.photo!.rgb);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const e = layers.originX + (c + 0.5) * s;
      const n = layers.originY - (r + 0.5) * s;
      const hit =
        side === 'east'
          ? e > ne.easting + 0.05 && e < ne.easting + 4 && n > sw.northing - 1 && n < ne.northing + 1
          : n < sw.northing - 0.05 && n > sw.northing - 4 && e > sw.easting - 1 && e < ne.easting + 1;
      if (!hit) continue;
      dsm[r * width + c] = 7 + (((r * 7 + c * 13) % 7) - 3) * 0.1;
      rgb.set([60, 130, 50], (r * width + c) * 3);
    }
  }
  return { ...layers, raster: { ...layers.raster, dsm }, photo: { ...layers.photo!, rgb } };
}

describe('edges-unverified at fixed shares (not the rule restated)', () => {
  it('a crown along a long side (about 0.37 of the outline) needs a review', () => {
    const roof = roofOnLayers(crownOn(hipLayers(LONG), LONG, 'south'), LONG_INSIDE)!;
    const share = roof.quality!.edgeSupport!.unverifiedShare;
    expect(share).toBeGreaterThan(0.3);
    expect(share).toBeLessThan(0.45);
    expect(roof.quality!.reasons).toContain('edges-unverified');
  });

  it('a crown along a short side (about 0.13 of the outline) does not', () => {
    const roof = roofOnLayers(crownOn(hipLayers(LONG), LONG, 'east'), LONG_INSIDE)!;
    const share = roof.quality!.edgeSupport!.unverifiedShare;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.2);
    expect(roof.quality!.reasons).not.toContain('edges-unverified');
  });

  it('an outline with a repeated corner: each edge keeps the index of its own first corner in the stored outline', () => {
    const layers = hipLayers(HOUSE);
    const roof = roofOnLayers(layers, INSIDE)!;
    // Repeat corner 1: eave support drops the zero-length edge, so its edges must map back past the repeat.
    const outline = [roof.outline[0]!, roof.outline[1]!, roof.outline[1]!, ...roof.outline.slice(2)];
    const again = withEdgeEvidence({ ...roof, outline, edges: undefined }, layers, null);
    expect(again.edges!.length).toBe(roof.outline.length);
    expect(again.edges!.map((e) => e.from)).toEqual([0, ...roof.outline.slice(1).map((_, k) => k + 2)]);
    for (const e of again.edges!) expect(outline[e.from]).not.toEqual(outline[(e.from + 1) % outline.length]);
  });
});

describe('eave evidence on the stored roof', () => {
  it('a clean hip roof: every edge strongly supported, no review for its edges', () => {
    const roof = roofOnLayers(hipLayers(HOUSE), INSIDE)!;
    expect(roof.edges).toBeDefined();
    expect(roof.edges!.length).toBe(roof.outline.length);
    expect(roof.edges!.every((e) => e.support === 'strong' && e.unverifiedShare === 0 && e.reason === null && !e.canopy)).toBe(true);
    expect(roof.quality!.edgeSupport!.unverifiedShare).toBe(0);
    expect(roof.quality!.reasons).not.toContain('edges-unverified');
    expect(roof.edges!.every((e) => e.confidence === EDGE_AGREEMENT.strong)).toBe(true);
    // The edges' lengths add up to the outline's perimeter (about 2 x (25 + 22) m).
    const perimeterFt = roof.edges!.reduce((t, e) => t + e.lengthFt, 0);
    expect(perimeterFt).toBeGreaterThan(290);
    expect(perimeterFt).toBeLessThan(330);
  });

  it('a tree crown against one eave: that edge unverified for the crown, drawn as such, and the roof reviewed when it is enough of the outline', () => {
    const roof = roofOnLayers(treeOnEast(hipLayers(HOUSE)), INSIDE)!;
    const hidden = roof.edges!.filter((e) => e.support === 'none');
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    expect(hidden.some((e) => e.reason === 'crown' && e.canopy)).toBe(true);
    const share = roof.quality!.edgeSupport!.unverifiedShare;
    // One side of four: about 22 of 94 m.
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.3);
    expect(roof.quality!.reasons.includes('edges-unverified')).toBe(share >= EDGES_UNVERIFIED_SHARE);
    expect(hidden.every((e) => e.confidence < 0.7)).toBe(true);
  });

  it('flags edges-unverified past the share (same tree, threshold crossed)', () => {
    const layers = treeOnEast(hipLayers(HOUSE));
    const roof = roofOnLayers(layers, INSIDE)!;
    // Strip the reason and recompute with the evidence alone: the decision is the threshold's.
    const plain: Roof3d = { ...roof, quality: { ...roof.quality!, reasons: [] } };
    const again = withEdgeEvidence(plain, layers, null);
    expect(again.quality!.edgeSupport!.unverifiedShare).toBe(roof.quality!.edgeSupport!.unverifiedShare);
    // Without a crown map the reason is the heights' own (a taller neighbour), and the share is the same.
    expect(again.edges!.some((e) => e.support === 'none' && e.reason === 'taller-neighbour')).toBe(true);
  });

  it('never throws: an outline it cannot read comes back with a typed failure and no edges', () => {
    const layers = hipLayers(HOUSE);
    const roof = roofOnLayers(layers, INSIDE)!;
    const bad = withEdgeEvidence({ ...roof, edges: undefined, outline: [roof.outline[0]!, roof.outline[0]!] }, layers, null);
    expect(bad.edges).toBeUndefined();
    expect(bad.quality!.edgeSupportFailure).toBe('bad-outline');
    const noZone = withEdgeEvidence(roof, { ...layers, epsg: 4326 }, null);
    expect(noZone.quality!.edgeSupportFailure).toBe('no-zone');
  });

  it('is deterministic: the same layers give byte-identical roofs', () => {
    const a = JSON.stringify(roofOnLayers(treeOnEast(hipLayers(HOUSE)), INSIDE));
    const b = JSON.stringify(roofOnLayers(treeOnEast(hipLayers(HOUSE)), INSIDE));
    expect(a).toBe(b);
  });
});

const q = (reasons: RoofQuality['reasons'], notes?: RoofQuality['reasons']): RoofQuality => ({
  imagery: 'HIGH',
  outlineIoU: 0.95,
  edgeFit: 1,
  faceCoverage: 0.98,
  meanResidualM: 0.05,
  treeShare: 0,
  fallbackFaces: 0,
  reasons,
  ...(notes !== undefined ? { notes } : {}),
});

describe('review reasons by severity (golden decisions)', () => {
  it('every reason has a severity', () => {
    for (const r of ROOF_QUALITY_REASONS) expect(['block', 'check', 'info']).toContain(ROOF_QUALITY_SEVERITY[r]);
  });

  const cases: [string, RoofQuality['reasons'], RoofQuality['reasons'], RoofQuality['reasons']][] = [
    ['a clean roof', [], [], []],
    ['differs from Google (filed as a review): stays a review', ['differs-from-google'], ['differs-from-google'], []],
    ['a low attachment stays a review (it changes the area)', ['low-attachment'], ['low-attachment'], []],
    ['unverified edges and a minor Google difference (a note)', ['edges-unverified'], ['edges-unverified'], ['differs-from-google']],
    ['hidden roof, joined buildings, patchy faces', ['roof-hidden', 'joined-buildings', 'faces-patchy'], ['roof-hidden', 'joined-buildings', 'faces-patchy'], []],
  ];
  for (const [name, input, reasons, notes] of cases) {
    it(name, () => {
      const out = tierReasons(q(input, notes.length > 0 && !input.includes(notes[0]!) ? notes : undefined));
      expect(out.reasons).toEqual(reasons);
      expect(out.notes ?? []).toEqual(notes);
      // Idempotent.
      expect(tierReasons(out)).toEqual(out);
    });
  }

  it('the Google check: a minor difference is a note, a difference over a third of the main roof a review, once', () => {
    const roof = roofOnLayers(hipLayers(HOUSE), INSIDE)!;
    // Google's segments under every face agree, except at 12/12 under the largest (ours is 6/12): one face of four.
    // Each segment as big as our face over it: only the pitch differs, so nothing is at stake in area.
    const seg = (f: Roof3d['faces'][number], pitchDeg: number) => ({ center: f.labelAt, pitchDeg, azimuthDeg: f.azimuthDeg, groundAreaM2: f.planAreaSqFt / 10.7639104167 });
    const agree = (Math.atan(0.5) * 180) / Math.PI;
    const building = { center: INSIDE, box: null, segments: roof.faces.map((f, k) => seg(f, k === 0 ? 45 : agree)) } as never;
    expect(differingShare(roof, building)).toBeLessThan(DIFFERS_AREA_SHARE);
    expect(differingStake(roof, building)).toBeLessThan(DIFFERS_STAKE_SHARE);
    const once = withGoogleCheck(roof, building);
    expect(once.quality!.notes).toEqual(['differs-from-google']);
    expect(once.quality!.reasons).not.toContain('differs-from-google');
    expect(withGoogleCheck(once, building).quality).toEqual(once.quality);
    // Two faces of four (the two largest, about half the roof): a review.
    const half = { center: INSIDE, box: null, segments: roof.faces.map((f, k) => seg(f, k <= 1 ? 45 : agree)) } as never;
    expect(differingShare(roof, half)).toBeGreaterThanOrEqual(DIFFERS_AREA_SHARE);
    expect(withGoogleCheck(roof, half).quality!.reasons).toContain('differs-from-google');
    expect(withGoogleCheck(roof, half).quality!.notes).toBeUndefined();
    // The disagreeing face loses confidence; the others keep their edges'.
    expect(once.faces[0]!.confidence).toBeCloseTo(EDGE_AGREEMENT.strong * 0.8, 3);
    expect(once.faces.slice(1).every((f) => f.confidence === EDGE_AGREEMENT.strong)).toBe(true);
    expect(formatCheck('hip', once, checkRoof(once, building))).toMatch(/unverified 0% \(0 ft\).*notes: differs-from-google/);
    // No segments at all: nothing to differ from.
    expect(withGoogleCheck(roof, null).quality).toEqual(roof.quality);
  });

  it("the Google check skips a face the lidar fusion measured (Google's segment there was fitted to the canopy)", () => {
    const roof = roofOnLayers(hipLayers(HOUSE), INSIDE)!;
    const seg = (f: Roof3d['faces'][number], pitchDeg: number) => ({ center: f.labelAt, pitchDeg, azimuthDeg: f.azimuthDeg, groundAreaM2: f.planAreaSqFt / 10.7639104167 });
    const agree = (Math.atan(0.5) * 180) / Math.PI;
    const building = { center: INSIDE, box: null, segments: roof.faces.map((f, k) => seg(f, k <= 1 ? 45 : agree)) } as never;
    expect(withGoogleCheck(roof, building).quality!.reasons).toContain('differs-from-google');
    const fused: Roof3d = { ...roof, faces: roof.faces.map((f, k) => (k <= 1 ? { ...f, source: 'lidar' as const, lidarShare: 0.9 } : f)) };
    expect(checkRoof(fused, building).rows.slice(0, 2).every((r) => !r.main)).toBe(true);
    expect(withGoogleCheck(fused, building).quality!.reasons).not.toContain('differs-from-google');
    expect(withGoogleCheck(fused, building).quality!.notes ?? []).not.toContain('differs-from-google');
  });

  it('a small differing face with much more area than Google sees under it is a review, not a note (ev-51881820-like)', () => {
    // The over-measured attachment: one face of four disagrees (under a third of the main roof), but Google's segment
    // under it is a third of our face's area. That gap alone moves the roof's area by more than DIFFERS_STAKE_SHARE.
    const roof = roofOnLayers(hipLayers(HOUSE), INSIDE)!;
    const smallest = roof.faces.reduce((m, f, k) => (f.planAreaSqFt < roof.faces[m]!.planAreaSqFt ? k : m), 0);
    const agree = (Math.atan(0.5) * 180) / Math.PI;
    const segments = roof.faces.map((f, k) => ({
      center: f.labelAt,
      pitchDeg: k === smallest ? 10 : agree,
      azimuthDeg: f.azimuthDeg,
      groundAreaM2: (k === smallest ? f.planAreaSqFt / 3 : f.planAreaSqFt) / 10.7639104167,
    }));
    const building = { center: INSIDE, box: null, segments } as never;
    expect(differingShare(roof, building)).toBeLessThan(DIFFERS_AREA_SHARE);
    expect(differingStake(roof, building)).toBeGreaterThanOrEqual(DIFFERS_STAKE_SHARE);
    const out = withGoogleCheck(roof, building);
    expect(out.quality!.reasons).toContain('differs-from-google');
    expect(needsReview(out)).toBe(true);
    // The same disagreement in pitch only (Google's segment as big as ours): a note.
    const pitchOnly = { center: INSIDE, box: null, segments: segments.map((g, k) => ({ ...g, groundAreaM2: roof.faces[k]!.planAreaSqFt / 10.7639104167 })) } as never;
    expect(withGoogleCheck(roof, pitchOnly).quality!.reasons).not.toContain('differs-from-google');
    expect(withGoogleCheck(roof, pitchOnly).quality!.notes).toEqual(['differs-from-google']);
  });

  it('face confidence follows the edges a face ends on', () => {
    const roof = roofOnLayers(treeOnEast(hipLayers(HOUSE)), INSIDE)!;
    const out = withFaceConfidence(roof, null);
    const low = out.faces.filter((f) => (f.confidence ?? 1) < 0.8);
    // The east face (sloping down to the east, azimuth about 90) ends on the hidden eave.
    expect(low.length).toBeGreaterThanOrEqual(1);
    expect(low.some((f) => Math.abs(f.azimuthDeg - 90) < 20)).toBe(true);
    // Without edges (an older roof) nothing changes.
    const old = { ...roof, edges: undefined };
    expect(withFaceConfidence(old, null)).toBe(old);
  });
});

describe('snapshots stored before this track still read', () => {
  const kept = JSON.parse(readFileSync(new URL('./fixtures/roof3d-snapshot-e3ae9615.json', import.meta.url), 'utf8')) as Roof3dSnapshot;

  it('a base-commit snapshot (no edges, no notes, no confidence) is a roof, stale by version, and still needs its review', () => {
    expect(isRoof3d(kept.roof)).toBe(true);
    expect(kept.roof!.edges).toBeUndefined();
    // Merge composition (confidence x hardening): it still reads and renders, but it was made by an older
    // reconstruction (no algorithmVersion = 1), so Measure rebuilds it instead of serving it for 30 days; within those
    // 30 days a current-version copy of the same snapshot would be fresh.
    expect(roof3dSnapshotVersion(kept).algorithm).toBe(1);
    expect(roof3dSnapshotFresh(kept, INSIDE, new Date('2026-10-13T00:00:00Z'))).toBe(false);
    expect(roof3dSnapshotFresh(roof3dSnapshotStamp(kept), INSIDE, new Date('2026-10-13T00:00:00Z'))).toBe(true);
    // Stored reasons are shown as stored: an older snapshot is never re-tiered behind the user's back.
    expect(needsReview(kept.roof)).toBe(true);
    expect(kept.roof!.quality!.reasons).toEqual(['faces-patchy', 'differs-from-google']);
  });

  it('the checks run on it without edges', () => {
    const roof = kept.roof!;
    expect(withFaceConfidence(roof, null)).toBe(roof);
    expect(() => formatCheck('old', roof, checkRoof(roof, null))).not.toThrow();
    expect(formatCheck('old', roof, checkRoof(roof, null))).toContain('edges: -');
  });
});

describe('edge confidence (algorithm 6: strong, weak and unverified weighed apart)', () => {
  it('orders the classes and mixes them by share', () => {
    expect(EDGE_AGREEMENT.strong).toBeGreaterThan(EDGE_AGREEMENT.weak);
    expect(EDGE_AGREEMENT.weak).toBeGreaterThan(EDGE_AGREEMENT.unverified);
    expect(edgeConfidence({ strongShare: 1, weakShare: 0, noneShare: 0 })).toBe(EDGE_AGREEMENT.strong);
    expect(edgeConfidence({ strongShare: 0, weakShare: 1, noneShare: 0 })).toBe(EDGE_AGREEMENT.weak);
    expect(edgeConfidence({ strongShare: 0, weakShare: 0, noneShare: 1 })).toBe(EDGE_AGREEMENT.unverified);
    expect(edgeConfidence({ strongShare: 0.5, weakShare: 0, noneShare: 0.5 })).toBeCloseTo((EDGE_AGREEMENT.strong + EDGE_AGREEMENT.unverified) / 2, 3);
    // A weak edge is trusted less than a strong one and more than an unverified one.
    const weakHalf = edgeConfidence({ strongShare: 0.5, weakShare: 0.5, noneShare: 0 });
    expect(weakHalf).toBeLessThan(EDGE_AGREEMENT.strong);
    expect(weakHalf).toBeGreaterThan(edgeConfidence({ strongShare: 0.5, weakShare: 0, noneShare: 0.5 }));
  });

  it('a tree crown beside one half of an eave counts the same whichever way the outline runs', () => {
    // The crown stands beside the north half of the east eave only. Before algorithm 6 the second half of an edge was
    // read at its midpoint, so the stretch was missed or not depending on the direction the ring ran.
    const layers = treeOnEast(hipLayers(HOUSE), true);
    const roof = roofOnLayers(layers, INSIDE)!;
    const rev = withEdgeEvidence({ ...roof, outline: [...roof.outline].reverse(), edges: undefined }, layers, null);
    const fwd = withEdgeEvidence({ ...roof, edges: undefined }, layers, null);
    expect(fwd.quality!.edgeSupport!.unverifiedShare).toBeGreaterThan(0.05);
    expect(rev.quality!.edgeSupport!.unverifiedShare).toBeCloseTo(fwd.quality!.edgeSupport!.unverifiedShare, 2);
  });
});
