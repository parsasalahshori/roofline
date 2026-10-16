import { describe, expect, it } from 'vitest';
import type { LngLat } from '@roofline/shared';
import { localFrame, type PanoCandidate, panoSearchPoints, pickPano } from '../../src/estimator/windows-geometry.ts';

/*
 * Which Street View panorama to photograph a house from. A 20 x 12 m house at latitude 36 (Fayetteville, AR): its
 * address street runs along the north side; a side street runs along the east side, nearer the outline's middle.
 */

const ORIGIN: LngLat = [-94.25, 36.07];
const frame = localFrame(ORIGIN);
const ring: LngLat[] = [frame.toLngLat([-10, -6]), frame.toLngLat([10, -6]), frame.toLngLat([10, 6]), frame.toLngLat([-10, 6])];
const at = (x: number, y: number) => frame.toLngLat([x, y]);
const pano = (panoId: string, x: number, y: number, from: PanoCandidate['from'], byGoogle = true): PanoCandidate => ({ panoId, location: at(x, y), byGoogle, from });

describe('picking the panorama', () => {
  it("a corner lot: the Google panorama on the address's street, not the nearer one on the side street", () => {
    const got = pickPano(ring, [
      pano('side-street', 18, 0, 'centre'), // 18 m east: the nearest
      pano('address-upload', 2, 22, 'address', false), // a person's upload on the address street (north)
      pano('north-google', -4, 24, 'side'),
      pano('south-alley', 0, -20, 'side'),
    ]);
    expect(got).toEqual({ pano: expect.objectContaining({ panoId: 'north-google' }), onAddressSide: true });
  });

  it("Google's own before an upload; the address's own panorama when it is Google's", () => {
    expect(pickPano(ring, [pano('addr', 0, 20, 'address'), pano('north', 6, 21, 'side')])!.pano.panoId).toBe('addr');
    // No Google panorama on the address's side: the address's (an upload) still shows the right side.
    expect(pickPano(ring, [pano('addr', 0, 20, 'address', false), pano('east', 18, 0, 'centre')])!.pano.panoId).toBe('addr');
  });

  it('without an address answer: the nearest Google panorama, else the nearest; too far is none', () => {
    expect(pickPano(ring, [pano('upload', 0, 15, 'centre', false), pano('google', 0, -25, 'side')])).toEqual({ pano: expect.objectContaining({ panoId: 'google' }), onAddressSide: null });
    expect(pickPano(ring, [pano('upload', 0, 15, 'centre', false)])!.pano.panoId).toBe('upload');
    expect(pickPano(ring, [pano('far', 0, 200, 'address')])).toBeNull();
    expect(pickPano(ring, [])).toBeNull();
  });

  it('the same panorama found twice counts once, as the address’s', () => {
    const got = pickPano(ring, [pano('same', 0, 20, 'centre'), pano('same', 0, 20, 'address')]);
    expect(got).toEqual({ pano: expect.objectContaining({ panoId: 'same', from: 'address' }), onAddressSide: true });
  });

  it('searches past each of the four sides', () => {
    const pts = panoSearchPoints(ring).map((p) => frame.toLocal(p));
    expect(pts).toHaveLength(4);
    // Along the 20 m walls: 10 + 15 m out east and west; across: 6 + 15 m north and south.
    const r = (v: number) => Math.round(v);
    expect(pts.map(([x, y]) => [r(x), r(y)]).sort()).toEqual([[-25, 0], [0, -21], [0, 21], [25, 0]].sort());
  });
});
