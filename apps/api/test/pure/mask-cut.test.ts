import { describe, expect, it } from 'vitest';
import { isRoof3d, type Ring, ROOF_MASK_CUT_SHARE, roofMaskCut } from '@roofline/shared';
import { lngLatToUtm } from '@roofline/shared/roof-reconstruct';
import { roofOnLayersResult } from '../../src/estimator/roof-3d.ts';
import type { RoofLayers } from '../../src/providers/solar-layers.ts';
import { hipLayers } from '../roof-3d-fixture.ts';
import { rng } from './tiffs.ts';

/*
 * FM11: the ground cut (mask parts lying on the ground) and the terrace cut remove part of Google's mask and clear it
 * from the mask the outline is checked against, so a 42% loss once showed a clean quality block. Every reconstruction
 * now records the cut (Roof3d.maskCut) with a typed reason when it removes more than 10%.
 */

const RING: Ring = [
  [-92.3, 34.75],
  [-92.2997, 34.75],
  [-92.2997, 34.7502],
  [-92.3, 34.7502],
  [-92.3, 34.75],
];
const INSIDE: [number, number] = [-92.29985, 34.7501];

/** The layers with Google's mask also covering a slab on the ground (`widthM` wide) along the house's east side. */
function withPatio(layers: RoofLayers, widthM: number): RoofLayers {
  const { width: W, height: H, pixelSizeM: s } = layers.raster;
  const zone = { zone: layers.epsg % 100, south: layers.epsg >= 32700 };
  const ne = lngLatToUtm(zone, RING[2]![0], RING[2]![1]);
  const sw = lngLatToUtm(zone, RING[0]![0], RING[0]![1]);
  const mask = layers.raster.mask.slice();
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const x = layers.originX + (c + 0.5) * s;
      const y = layers.originY - (r + 0.5) * s;
      if (x > ne.easting && x <= ne.easting + widthM && y >= sw.northing && y <= ne.northing) mask[r * W + c] = 1;
    }
  }
  // No photo: the fixture paints all ground green, and the ground plane is fitted on ground that is not green.
  return { ...layers, photo: null, raster: { ...layers.raster, mask } };
}

describe('the mask cut is recorded and typed', () => {
  it('a clean roof: a cut of nothing, no reason', () => {
    const found = roofOnLayersResult(hipLayers(RING), INSIDE);
    expect('roof' in found && found.roof.maskCut).toMatchObject({ groundSqFt: 0, terraceSqFt: 0, removedShare: 0, reason: null });
  });

  it('a patio on the ground the mask took for roof: cut, and over 10% it says ground-cut', () => {
    const found = roofOnLayersResult(withPatio(hipLayers(RING), 8), INSIDE);
    expect('roof' in found).toBe(true);
    const cut = 'roof' in found ? found.roof.maskCut! : null;
    expect(cut!.groundSqFt).toBeGreaterThan(0);
    expect(cut!.removedShare).toBeGreaterThan(ROOF_MASK_CUT_SHARE);
    expect(cut!.reason).toBe('ground-cut');
  });

  it('property: whatever is cut, a cut over 10% of the mask never goes without its reason (random patios and green masks)', () => {
    const next = rng(11);
    const base = hipLayers(RING);
    for (let k = 0; k < 8; k++) {
      const layers = withPatio(base, 1 + next() * 10);
      const green = new Uint8Array(layers.raster.width * layers.raster.height).map(() => (next() < next() * 0.6 ? 1 : 0));
      const found = roofOnLayersResult({ ...layers, raster: { ...layers.raster, green } }, INSIDE);
      if (!('roof' in found)) continue;
      const cut = found.roof.maskCut!;
      expect(cut.removedShare > ROOF_MASK_CUT_SHARE, `case ${k}`).toBe(cut.reason !== null);
    }
  });

  it('merge composition (hardening x confidence): the cut roof also carries its edge evidence, and still reads as a roof', () => {
    const found = roofOnLayersResult(withPatio(hipLayers(RING), 8), INSIDE);
    expect('roof' in found).toBe(true);
    const roof = 'roof' in found ? found.roof : null;
    expect(roof!.maskCut!.reason).toBe('ground-cut');
    expect(roof!.edges!.length).toBeGreaterThanOrEqual(4);
    expect(roof!.quality!.edgeSupport).toBeDefined();
    expect(roof!.quality!.edgeSupportFailure).toBeUndefined();
    expect(isRoof3d(JSON.parse(JSON.stringify(roof)))).toBe(true);
  });

  it('roofMaskCut is total: garbage in, null out', () => {
    expect(roofMaskCut(null)).toBeNull();
    expect(roofMaskCut({ maskM2: 0, groundM2: 0, terraceM2: 0 })).toBeNull();
    expect(roofMaskCut({ maskM2: Number.NaN, groundM2: 0, terraceM2: 0 })).toBeNull();
    expect(roofMaskCut({ maskM2: 100, groundM2: 5, terraceM2: 20 })).toMatchObject({ removedShare: 0.25, reason: 'terrace-cut' });
  });
});
