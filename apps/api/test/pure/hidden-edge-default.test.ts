import { describe, expect, it } from 'vitest';
import { type Ring, ROOF_3D_ALGORITHM_VERSION } from '@roofline/shared';
import { lngLatToUtm } from '@roofline/shared/roof-reconstruct';
import { DEFAULT_HIDDEN_EDGE, roofOnLayersResult } from '../../src/estimator/roof-3d.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';

/*
 * The server's hidden-edge step (ROOF_3D_ALGORITHM_VERSION 4): roofOnLayers runs DEFAULT_HIDDEN_EDGE (photo, then
 * planes) unless told `hiddenEdge: null`. A tree crown over the middle of the south eave of the fixture's hip roof (its
 * pixels out of Google's mask, as Google's mask leaves crowns out) makes the outline stop short there; the step puts the
 * eave back. A roof with nothing hidden is untouched.
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

describe('the server runs the hidden-edge step by default (ROOF_3D_ALGORITHM_VERSION 4)', () => {
  it('the default is photo+planes, and the version says so', () => {
    expect(DEFAULT_HIDDEN_EDGE).toEqual({ method: 'photo+planes' });
    expect(ROOF_3D_ALGORITHM_VERSION).toBe(4);
  });

  it('a roof with nothing hidden: the default output is byte-identical to the step turned off', () => {
    const on = roofOnLayersResult(hipLayers(RING), INSIDE);
    const off = roofOnLayersResult(hipLayers(RING), INSIDE, { hiddenEdge: null });
    expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  });

  it('a crown over the south eave: off stops short under it, the default puts the eave back within half a metre', () => {
    const layers = withCrown(hipLayers(RING), 2.6, 0.5);
    const off = roofOnLayersResult(layers, INSIDE, { hiddenEdge: null });
    const on = roofOnLayersResult(layers, INSIDE);
    expect('roof' in off && 'roof' in on).toBe(true);
    if (!('roof' in off) || !('roof' in on)) return;
    // Reproduces the problem: without the step the eave under the crown is more than 0.8 m inside the true one.
    expect(southAtMiddle(layers, off.roof.outline)).toBeGreaterThan(0.8);
    expect(Math.abs(southAtMiddle(layers, on.roof.outline))).toBeLessThan(0.5);
    // The inferred eave is still not verified by the heights (the crown stands over it).
    expect(on.roof.edges?.some((e) => e.support === 'none')).toBe(true);
  });

  it('without a photo the photo step declines and the planes step still runs; never a throw', () => {
    const layers = { ...withCrown(hipLayers(RING), 2.6, 0.5), photo: null };
    const on = roofOnLayersResult(layers, INSIDE);
    expect('roof' in on).toBe(true);
    if ('roof' in on) expect(Math.abs(southAtMiddle(layers, on.roof.outline))).toBeLessThan(0.5);
  });

  it('is deterministic: the default gives byte-identical output on a rerun', () => {
    const layers = withCrown(hipLayers(RING), 2.6, 0.5);
    expect(JSON.stringify(roofOnLayersResult(layers, INSIDE))).toBe(JSON.stringify(roofOnLayersResult(layers, INSIDE)));
  });
});
