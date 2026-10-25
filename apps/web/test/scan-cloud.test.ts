import { describe, expect, it } from 'vitest';
import { cloudPoints, cloudUv, fitCloud, scaleBar, toPanel } from '../src/features/scans/cloudGeometry.ts';

describe('the 3D rebuild’s geometry', () => {
  it('reads the server’s points, with a grey for points that have no colour and nothing for broken rows', () => {
    expect(cloudPoints([[0, 1, -3, 10, 20, 30], [1, 2, 3], [Number.NaN, 0, 0], [1]])).toEqual([
      { x: 0, y: 1, z: -3, r: 10, g: 20, b: 30 },
      { x: 1, y: 2, z: 3, r: 150, g: 150, b: 150 },
    ]);
  });

  it('from above the wall runs along the page and depth goes down it; from the side depth runs right to left and height up', () => {
    expect(cloudUv('top', [0.5, 1.4, -3])).toEqual([0.5, -3]);
    expect(cloudUv('side', [0.5, 1.4, -3])).toEqual([3, -1.4]);
    // facing the wall: x to the right, height up the page
    expect(cloudUv('front', [0.5, 1.4, -3])).toEqual([0.5, -1.4]);
    // a camera in front of the wall (z = 0) is below it (larger v) from above, and to the left of it from the side
    expect(cloudUv('top', [0, 1, 0])[1]).toBeGreaterThan(cloudUv('top', [0, 1, -3])[1]);
    expect(cloudUv('side', [0, 1, 0])[0]).toBeLessThan(cloudUv('side', [0, 1, -3])[0]);
  });

  it('fits the scene in the panel with room round it, the same scale both ways, a stray point not shrinking it', () => {
    const uv = Array.from({ length: 200 }, (_, i) => [(i % 20) * 0.1, Math.floor(i / 20) * 0.1] as [number, number]);
    const stray: [number, number][] = [...uv, [40, 40]];
    const fit = fitCloud(uv, [], 360, 240);
    const withStray = fitCloud(stray, [], 360, 240);
    expect(withStray.scale).toBeGreaterThan(fit.scale * 0.8);
    const [x0, y0] = toPanel(fit, [0, 0]);
    const [x1, y1] = toPanel(fit, [1.9, 0.9]);
    expect(Math.min(x0, y0)).toBeGreaterThanOrEqual(17);
    expect(x1).toBeLessThanOrEqual(343);
    expect(y1).toBeLessThanOrEqual(223);
    // the corners and the cameras are always inside
    const withCameras = fitCloud(uv, [[5, 5]], 360, 240);
    const [cx, cy] = toPanel(withCameras, [5, 5]);
    expect(cx).toBeLessThanOrEqual(342);
    expect(cy).toBeLessThanOrEqual(222);
    expect(fitCloud([], [], 360, 240).scale).toBe(100);
  });

  it('a scale bar is a round number of metres, about 80 px long', () => {
    for (const scale of [40, 90, 150, 400, 700]) {
      const bar = scaleBar(scale);
      expect([0.1, 0.2, 0.5, 1, 2, 5]).toContain(bar.metres);
      expect(bar.px).toBeCloseTo(bar.metres * scale, 9);
      expect(bar.px).toBeGreaterThan(40);
      expect(bar.px).toBeLessThan(160);
    }
    expect(scaleBar(100)).toEqual({ metres: 1, px: 100 });
    expect(scaleBar(200).metres).toBe(0.5);
  });
});
