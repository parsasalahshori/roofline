// Edge provenance for lidar fusion (estimator/roof-3d.ts lidarEdgeShares): an outline edge is the lidar's when the
// pixels just inside it came from the lidar. Hermetic, synthetic.
import { describe, expect, it } from 'vitest';
import { lidarEdgeShares } from '../../src/estimator/roof-3d.ts';

describe('lidarEdgeShares', () => {
  // A 10 x 6 m rectangle on a 0.1 m grid (raster metres: x east, y north from the top edge, so y <= 0).
  const W = 200;
  const H = 120;
  const s = 0.1;
  const rect = [
    { x: 5, y: -3 },
    { x: 15, y: -3 },
    { x: 15, y: -9 },
    { x: 5, y: -9 },
  ];
  // Lidar pixels: the east 4 m of the rectangle (x >= 11).
  const px = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (c * s >= 11 && c * s < 15 && r * s >= 3 && r * s < 9) px[r * W + c] = 1;

  for (const ring of [rect, [...rect].reverse()]) {
    it(`marks the east edge whole, the long edges by share, the west edge not (${ring === rect ? 'clockwise' : 'counter-clockwise'})`, () => {
      const sh = lidarEdgeShares(ring, px, W, H, s);
      expect(sh).toHaveLength(4);
      const east = ring.findIndex((p, i) => p.x === 15 && ring[(i + 1) % 4]!.x === 15);
      const west = ring.findIndex((p, i) => p.x === 5 && ring[(i + 1) % 4]!.x === 5);
      expect(sh[east]).toBe(1);
      expect(sh[west]).toBe(0);
      for (let i = 0; i < 4; i++) if (i !== east && i !== west) expect(sh[i]).toBeCloseTo(0.4, 1);
    });
  }

  it('ignores repeated corners and stays on the grid', () => {
    const rep = [rect[0]!, rect[0]!, ...rect.slice(1)];
    expect(lidarEdgeShares(rep, px, W, H, s)).toEqual(lidarEdgeShares(rect, px, W, H, s));
    expect(lidarEdgeShares([{ x: -50, y: 10 }, { x: -40, y: 10 }, { x: -40, y: 0 }], px, W, H, s)).toEqual([0, 0, 0]);
  });
});
