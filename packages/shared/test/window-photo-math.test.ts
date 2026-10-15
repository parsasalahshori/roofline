import { describe, expect, it } from 'vitest';
import { focalPxFrom35mm, homography, applyHomography, rectangleAspect, sizeFromKnownSide, sizeFromReference } from '../src/window-photo-math.ts';
import type { Pt, Quad } from '../src/window-photo-math.ts';

// A phone photo of a wall plane: 4032 x 3024 px, 26 mm-equivalent lens, the wall turned `yawDeg` and tilted `pitchDeg`,
// `distIn` inches from the camera. Plane points are inches with x right and y down.
function camera(yawDeg: number, pitchDeg: number, distIn: number, W = 4032, H = 3024) {
  const f = focalPxFrom35mm(26, W, H);
  const a = (yawDeg * Math.PI) / 180;
  const b = (pitchDeg * Math.PI) / 180;
  return (p: Pt): Pt => {
    // Rotate about y (yaw), then about x (pitch), then push out along z.
    const x1 = p[0] * Math.cos(a);
    const z1 = p[0] * Math.sin(a);
    const y2 = p[1] * Math.cos(b) - z1 * Math.sin(b);
    const z2 = p[1] * Math.sin(b) + z1 * Math.cos(b) + distIn;
    return [(f * x1) / z2 + W / 2, (f * y2) / z2 + H / 2];
  };
}
const rect = (x: number, y: number, w: number, h: number): Quad => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const shot = (cam: (p: Pt) => Pt, q: Quad) => q.map(cam) as Quad;

describe('window photo math', () => {
  it('a homography maps the four corners it was built from', () => {
    const src: Quad = [[10, 20], [400, 35], [380, 300], [5, 280]];
    const dst: Quad = [[0, 0], [8.5, 0], [8.5, 11], [0, 11]];
    const H = homography(src, dst)!;
    src.forEach((p, i) => {
      const [u, v] = applyHomography(H, p);
      expect(u).toBeCloseTo(dst[i]![0], 6);
      expect(v).toBeCloseTo(dst[i]![1], 6);
    });
  });

  it('three corners in a line have no homography', () => {
    expect(homography([[0, 0], [1, 1], [2, 2], [3, 3]], [[0, 0], [1, 0], [1, 1], [0, 1]])).toBeNull();
  });

  for (const [yaw, pitch] of [[0, 0], [25, 0], [35, 10], [-40, -8]] as const) {
    it(`a sheet of letter paper on the glass sizes a 36 x 60 in window (wall turned ${yaw} deg, tilted ${pitch} deg)`, () => {
      const cam = camera(yaw, pitch, 110);
      const windowQuad = shot(cam, rect(-18, -30, 36, 60));
      const paper = shot(cam, rect(-4.25, -5.5, 8.5, 11));
      const s = sizeFromReference(windowQuad, paper, 8.5, 11)!;
      expect(s.widthIn).toBeCloseTo(36, 1);
      expect(s.heightIn).toBeCloseTo(60, 1);
    });

    it(`one measured side gives the other from the corners alone (wall turned ${yaw} deg, tilted ${pitch} deg)`, () => {
      const cam = camera(yaw, pitch, 120);
      const q = shot(cam, rect(-15, -27, 30, 54));
      const byWidth = sizeFromKnownSide(q, 4032, 3024, 'width', 30)!;
      expect(byWidth.heightIn / 54).toBeCloseTo(1, 2);
      const byHeight = sizeFromKnownSide(q, 4032, 3024, 'height', 54)!;
      expect(byHeight.widthIn / 30).toBeCloseTo(1, 2);
    });
  }

  it('a wrong focal length still lands close when the photo is nearly straight on', () => {
    const cam = camera(8, 3, 120);
    const q = shot(cam, rect(-18, -24, 36, 48));
    const aspect = rectangleAspect(q, 4032, 3024, focalPxFrom35mm(28, 4032, 3024))!;
    expect(Math.abs(aspect / 0.75 - 1)).toBeLessThan(0.02);
  });
});
