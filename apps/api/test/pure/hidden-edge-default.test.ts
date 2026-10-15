import { describe, expect, it } from 'vitest';
import { isRoof3d, type Ring, ROOF_3D_ALGORITHM_VERSION } from '@roofline/shared';
import { lngLatToUtm } from '@roofline/shared/roof-reconstruct';
import { DEFAULT_HIDDEN_EDGE, roofOnLayersResult } from '../../src/estimator/roof-3d.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';

/*
 * The server's hidden-edge step (ROOF_3D_ALGORITHM_VERSION 5, docs/roof-3d/outline-remediate.md): off by default again
 * (version 4 ran photo+planes by default). A tree crown over the middle of the south eave of the fixture's hip roof
 * (its pixels out of Google's mask, as Google's mask leaves crowns out) makes the outline stop short there. With the
 * step asked for, what it infers is recorded on the stored roof (Roof3d.inferredEdges) and, past a few square feet,
 * sent for review ('roof-inferred'), so inferred roof is never priced as measured roof.
 */

const RING: Ring = [
  [-92.3, 34.75],
  [-92.2997, 34.75],
  [-92.2997, 34.7502],
  [-92.3, 34.7502],
  [-92.3, 34.75],
];
const INSIDE: [number, number] = [-92.29985, 34.7501];

/** The layers with a rough, green crown of radius `rad` centred `outM` south of the south eave's middle. */
function withCrown(layers: RoofLayers, rad: number, outM: number): RoofLayers {
  const { width: W, height: H, pixelSizeM: s } = layers.raster;
  const zone = { zone: layers.epsg % 100, south: layers.epsg >= 32700 };
  const sw = lngLatToUtm(zone, RING[0]![0], RING[0]![1]);
  const se = lngLatToUtm(zone, RING[1]![0], RING[1]![1]);
  const cx = (sw.easting + se.easting) / 2;
  const cy = sw.northing - outM;
  const dsm = Float32Array.from(layers.raster.dsm);
  const mask = Uint8Array.from(layers.raster.mask);
  const rgb = Uint8Array.from(layers.photo!.rgb);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = layers.originX + (c + 0.5) * s;
      const y = layers.originY - (r + 0.5) * s;
      const d = Math.hypot(x - cx, y - cy);
      if (d > rad) continue;
      // Above the eave (4 m) by up to 4 m, with a deterministic ripple: foliage is rough.
      const z = 8 - (d * d) / (rad * 1.5) + 0.25 * Math.sin(x * 7.3) * Math.cos(y * 6.1);
      const i = r * W + c;
      if (z <= dsm[i]!) continue;
      dsm[i] = z;
      mask[i] = 0;
      rgb.set([40, 90, 35], i * 3);
    }
  }
  return { ...layers, raster: { ...layers.raster, dsm, mask }, photo: { ...layers.photo!, rgb } };
}

/** The outline's southernmost northing under the crown's middle (the eave line there), metres. */
function southAtMiddle(layers: RoofLayers, outline: readonly [number, number][]): number {
  const zone = { zone: layers.epsg % 100, south: layers.epsg >= 32700 };
  const pts = outline.map(([lng, lat]) => lngLatToUtm(zone, lng, lat));
  const sw = lngLatToUtm(zone, RING[0]![0], RING[0]![1]);
  const se = lngLatToUtm(zone, RING[1]![0], RING[1]![1]);
  const mid = (sw.easting + se.easting) / 2;
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    if ((a.easting - mid) * (b.easting - mid) > 0 || a.easting === b.easting) continue;
    const t = (mid - a.easting) / (b.easting - a.easting);
    best = Math.min(best, a.northing + t * (b.northing - a.northing));
  }
  return best - sw.northing;
}

describe('the server does not run the hidden-edge step by default (ROOF_3D_ALGORITHM_VERSION 5)', () => {
  it('the default is off, and the version moved on from 4 (its roofs are stale)', () => {
    expect(DEFAULT_HIDDEN_EDGE).toBeNull();
    expect(ROOF_3D_ALGORITHM_VERSION).toBe(5);
  });

  it('a crown over the south eave: the default output is byte-identical to the step turned off, with no inferred record', () => {
    const layers = withCrown(hipLayers(RING), 2.6, 0.5);
    const def = roofOnLayersResult(layers, INSIDE);
    const off = roofOnLayersResult(layers, INSIDE, { hiddenEdge: null });
    expect(JSON.stringify(def)).toBe(JSON.stringify(off));
    expect('roof' in def && def.roof.inferredEdges).toBeFalsy();
    // Reproduces the shape of the problem the step addresses: the eave under the crown is short.
    if ('roof' in off) expect(southAtMiddle(layers, off.roof.outline)).toBeGreaterThan(0.8);
  });

  it('asked for, under a dense crown: the move is refused for want of evidence, and the record says the step ran', () => {
    const layers = withCrown(hipLayers(RING), 2.6, 0.5);
    const off = roofOnLayersResult(layers, INSIDE, { hiddenEdge: null });
    const on = roofOnLayersResult(layers, INSIDE, { hiddenEdge: { method: 'photo+planes' } });
    expect('roof' in off && 'roof' in on).toBe(true);
    if (!('roof' in off) || !('roof' in on)) return;
    expect(on.roof.outline).toEqual(off.roof.outline);
    expect(on.roof.inferredEdges).toEqual({ methods: ['photo', 'planes'], edges: [], addedSqFt: 0, removedSqFt: 0 });
    expect(on.roof.quality?.reasons).not.toContain('roof-inferred');
  });

  it('asked for as a hypothesis: the eave goes back, and the stored roof says which edge was inferred and how much area, with a review', () => {
    const layers = withCrown(hipLayers(RING), 2.6, 0.5);
    const on = roofOnLayersResult(layers, INSIDE, { hiddenEdge: { method: 'photo+planes', planes: { minDeepSeenShare: 0 } } });
    expect('roof' in on).toBe(true);
    if (!('roof' in on)) return;
    expect(Math.abs(southAtMiddle(layers, on.roof.outline))).toBeLessThan(0.5);
    const inf = on.roof.inferredEdges;
    expect(inf?.methods).toEqual(['photo', 'planes']);
    expect(inf?.edges.length ?? 0).toBeGreaterThan(0);
    for (const e of inf?.edges ?? []) {
      expect(e.method).toBe('planes');
      expect(e.from).toBeGreaterThanOrEqual(0);
      expect(e.from).toBeLessThan(on.roof.outline.length);
    }
    // About a 4 m x 1.5 m bite of a crown (some 60 sq ft): over 3 m2, so the roof is sent for review before pricing.
    expect(inf!.addedSqFt).toBeGreaterThan(32);
    expect(on.roof.quality?.reasons).toContain('roof-inferred');
    // The inferred eave is still not verified by the heights (the crown stands over it).
    expect(on.roof.edges?.some((e) => e.support === 'none')).toBe(true);
  });

  it('an older stored roof without the record still reads as a roof', () => {
    const off = roofOnLayersResult(hipLayers(RING), INSIDE, { hiddenEdge: null });
    expect('roof' in off).toBe(true);
    if ('roof' in off) {
      const old: Record<string, unknown> = { ...off.roof };
      delete old.inferredEdges;
      expect(isRoof3d(old)).toBe(true);
    }
  });

  it('never throws, and is deterministic, with the step asked for (photo or none)', () => {
    for (const photo of [true, false]) {
      const base = withCrown(hipLayers(RING), 2.6, 0.5);
      const layers = photo ? base : { ...base, photo: null };
      const a = roofOnLayersResult(layers, INSIDE, { hiddenEdge: { method: 'photo+planes', planes: { minDeepSeenShare: 0 } } });
      expect('roof' in a).toBe(true);
      expect(JSON.stringify(a)).toBe(JSON.stringify(roofOnLayersResult(layers, INSIDE, { hiddenEdge: { method: 'photo+planes', planes: { minDeepSeenShare: 0 } } })));
    }
  });
});
