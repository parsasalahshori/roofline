import { describe, expect, it } from 'vitest';
import { resampleFromEnv, resampleGrid, resamplePhoto } from '../../src/bench/roof3d/data.ts';

// The benchmark's MEDIUM run (ROOF3D_BENCH_RESAMPLE_M): every layer, the photo included, box-filtered to 0.25 m.
const grid = (w: number, h: number, data: number[], noData: number | null = null) => ({ width: w, height: h, originX: 0, originY: 0, pixelX: 0.1, pixelY: 0.1, epsg: 32615, data, noData });

describe('MEDIUM resampling for the benchmark', () => {
  it('reads the pixel size from the environment and refuses nonsense', () => {
    expect(resampleFromEnv({})).toBe(0);
    expect(resampleFromEnv({ ROOF3D_BENCH_RESAMPLE_M: '' })).toBe(0);
    expect(resampleFromEnv({ ROOF3D_BENCH_RESAMPLE_M: '0.25' })).toBe(0.25);
    expect(() => resampleFromEnv({ ROOF3D_BENCH_RESAMPLE_M: 'medium' })).toThrow();
    expect(() => resampleFromEnv({ ROOF3D_BENCH_RESAMPLE_M: '2' })).toThrow();
  });

  it('heights: area-weighted mean of the finite ones; no data when under half the area has one', () => {
    // 5 x 5 at 0.1 m to 0.25 m: 2 x 2 cells; the first covers columns 0, 1 and half of 2.
    const d = Array.from({ length: 25 }, (_, i) => i % 5);
    const out = resampleGrid(grid(5, 5, d), 0.25, 'height');
    expect([out.width, out.height, out.pixelX]).toEqual([2, 2, 0.25]);
    expect(out.data[0]).toBeCloseTo((0 * 0.1 + 1 * 0.1 + 2 * 0.05) / 0.25, 6);
    const holes = resampleGrid(grid(5, 5, d.map((v, i) => (i % 5 < 2 ? -9999 : v)), -9999), 0.25, 'height');
    expect(Number.isNaN(holes.data[0])).toBe(true);
    expect(holes.data[1]).toBeCloseTo((2 * 0.05 + 3 * 0.1 + 4 * 0.1) / 0.25, 6);
  });

  it('mask: roof when at least half the cell is roof', () => {
    const m = Array.from({ length: 25 }, (_, i) => (i % 5 < 2 ? 1 : 0));
    const out = resampleGrid(grid(5, 5, m), 0.25, 'mask');
    expect(Array.from(out.data)).toEqual([1, 0, 1, 0]);
  });

  it('photo: the area-weighted mean colour, on the same 0.25 m grid', () => {
    const rgb = new Uint8Array(5 * 5 * 3);
    for (let i = 0; i < 25; i++) rgb.set(i % 5 < 2 ? [200, 100, 0] : [0, 100, 200], i * 3);
    const out = resamplePhoto({ width: 5, height: 5, pixelSizeM: 0.1, originX: 0, originY: 0, rgb }, 0.25);
    expect([out.width, out.height, out.pixelSizeM]).toEqual([2, 2, 0.25]);
    expect(Array.from(out.rgb.slice(0, 3))).toEqual([160, 100, 40]);
  });
});
