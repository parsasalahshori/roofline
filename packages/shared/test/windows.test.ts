import { describe, expect, it } from 'vitest';
import { DEFAULT_WINDOW_TIERS, priceWindows, windowCounts, windowSizeClass } from '../src/windows.ts';
import type { MeasuredWindow, WindowMeasurementView } from '../src/windows.ts';

const win = (id: string, widthIn: number, heightIn: number): MeasuredWindow => ({
  id, photoId: 'p1', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, widthIn, heightIn, sizeClass: windowSizeClass(widthIn, heightIn), floor: 1, confidence: 0.9,
});
const view = (over: Partial<WindowMeasurementView> = {}): Pick<WindowMeasurementView, 'windows' | 'estimated' | 'adjustments'> => ({
  windows: [win('a', 36, 60), win('b', 36, 60), win('c', 72, 60)],
  estimated: { bySizeClass: { small: 2, standard: 6, large: 0, picture: 0 }, basis: 'test' },
  adjustments: { excludedWindowIds: [], manualCounts: {} },
  ...over,
});

describe('windows', () => {
  it('sorts a window into a size class by united inches', () => {
    expect(windowSizeClass(24, 36)).toBe('small');
    expect(windowSizeClass(36, 60)).toBe('standard');
    expect(windowSizeClass(48, 66)).toBe('large');
    expect(windowSizeClass(72, 60)).toBe('picture');
  });

  it('counts measured and estimated windows apart, honouring left-out windows and typed counts', () => {
    const c = windowCounts(view({ adjustments: { excludedWindowIds: ['b'], manualCounts: { small: 0 } } }));
    expect(c.standard).toEqual({ measured: 1, estimated: 6 });
    expect(c.picture).toEqual({ measured: 1, estimated: 0 });
    expect(c.small).toEqual({ measured: 0, estimated: 0 });
  });

  it('photographed windows count as measured, and once they cover every window the estimate counts nothing', () => {
    const photo = { id: 'ph1', uploadId: 'u1', corners: [[0, 0], [1, 0], [1, 1], [0, 1]] as [[number, number], [number, number], [number, number], [number, number]], scale: { kind: 'known-side' as const, side: 'width' as const, inches: 30 }, widthIn: 30, heightIn: 54, sizeClass: 'standard' as const, quality: 'good' as const };
    const c = windowCounts({ ...view(), photoWindows: [photo] });
    expect(c.standard).toEqual({ measured: 3, estimated: 6 });
    const all = windowCounts({ ...view({ adjustments: { excludedWindowIds: [], manualCounts: {}, photosCoverAllWindows: true } }), photoWindows: [photo] });
    expect(all.standard).toEqual({ measured: 3, estimated: 0 });
    expect(all.small).toEqual({ measured: 0, estimated: 0 });
  });

  it('prices every counted window at each tier', () => {
    const q = priceWindows(windowCounts(view()));
    expect(q.map((t) => t.tier)).toEqual(['good', 'better', 'best']);
    const good = q[0]!;
    expect(good.windows).toBe(11);
    const p = DEFAULT_WINDOW_TIERS[0]!.priceCents;
    expect(good.totalCents).toBe(2 * p.small + 8 * p.standard + 1 * p.picture);
  });
});
