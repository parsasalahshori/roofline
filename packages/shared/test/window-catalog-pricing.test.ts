import { describe, expect, it } from 'vitest';
import {
  buildHomeownerQuote,
  DEFAULT_ADDERS,
  estimatedOf,
  lineOptionCents,
  priceCatalogWindows,
  pricedWindowsOf,
  resolveCatalog,
  type WindowCatalog,
  type WindowCounts,
} from '../src/index.ts';

const catalog: WindowCatalog = {
  ...resolveCatalog(null),
  tiers: [
    { tier: 'good', label: 'Replenish', note: '1-year warranty', name: 'Economy', description: 'd', priceCents: { small: 40_000, standard: 50_000, large: 60_000, picture: 80_000 }, enabled: true },
    { tier: 'better', name: 'Elite', description: 'd', priceCents: { small: 50_000, standard: 60_000, large: 70_000, picture: 90_000 }, enabled: true },
    { tier: 'best', name: 'Exec', description: 'd', priceCents: { small: 60_000, standard: 70_000, large: 80_000, picture: 100_000 }, enabled: false },
  ],
  styleAdjustCents: { sideways: { good: 2_000 } },
  adders: { ...DEFAULT_ADDERS, frostedCents: 4_500, exteriorColorCents: 6_000, woodInteriorCents: 8_500, gridColonialCents: 3_500, gridQueenAnneCents: 5_500 },
};
const none = { small: 0, standard: 0, large: 0, picture: 0 };

describe('priceCatalogWindows', () => {
  it('prices each measured window by its style and frosted glass, and the estimated ones at the base style', () => {
    const q = priceCatalogWindows(
      catalog,
      [
        { sizeClass: 'standard' },
        { sizeClass: 'standard', style: 'slider-2', frosted: true },
        { sizeClass: 'large', style: 'arch' },
      ],
      { ...none, small: 2 },
    );
    expect(q.map((x) => x.tier)).toEqual(['good', 'better']);
    const good = q[0]!;
    // standard: 50,000 + (52,000 + 4,500); small x2 estimated: 80,000; the arch is left to the visit
    expect(good.lines).toEqual([
      { sizeClass: 'small', count: 2, unitCents: 40_000, amountCents: 80_000 },
      { sizeClass: 'standard', count: 2, unitCents: 53_250, amountCents: 106_500 },
    ]);
    expect(good.totalCents).toBe(186_500);
    expect(good.windows).toBe(4);
    expect(good.atVisitCount).toBe(1);
    expect(q[1]!.totalCents).toBe(2 * 60_000 + 4_500 + 2 * 50_000);
  });

  it('gives the same per-window cents as the homeowner quote', () => {
    const measured = [
      { id: 'a', sizeClass: 'standard' as const, style: 'slider-2' as const, frosted: true },
      { id: 'b', sizeClass: 'picture' as const, style: 'picture' as const },
    ];
    const home = buildHomeownerQuote({ measured, expected: null, override: null, mix: null, catalog });
    const staff = priceCatalogWindows(catalog, measured, none);
    for (const t of staff) expect(t.totalCents / 100).toBe(home.tiers.find((h) => h.key === t.tier)!.total);
  });

  it('with no style or frosted glass, prices as the sizes alone', () => {
    const q = priceCatalogWindows(catalog, [{ sizeClass: 'small' }], { ...none, large: 1 });
    expect(q[0]!.totalCents).toBe(40_000 + 60_000);
    expect(q[0]!.atVisitCount).toBeUndefined();
  });
});

describe('pricedWindowsOf and estimatedOf', () => {
  const photo = (id: string, extra: object = {}) => ({ id, widthIn: 36, heightIn: 60, sizeClass: 'standard' as const, quality: 'good' as const, scale: {} as never, ...extra });
  it('counts a window shared by several photos once, with its style and any frosted photo', () => {
    const w = pricedWindowsOf({
      windows: [{ id: 'm1', sizeClass: 'small' } as never],
      adjustments: { excludedWindowIds: [], manualCounts: {} },
      photoWindows: [photo('p1', { windowKey: 'k' }), photo('p2', { windowKey: 'k', style: 'slider-2', frosted: true }), photo('p3', { style: 'picture' })] as never,
    });
    expect(w).toEqual([{ sizeClass: 'small' }, { sizeClass: 'standard', style: 'slider-2', frosted: true }, { sizeClass: 'standard', style: 'picture' }]);
  });
  it('leaves excluded windows out', () => {
    const w = pricedWindowsOf({ windows: [{ id: 'm1', sizeClass: 'small' } as never], adjustments: { excludedWindowIds: ['m1', 'p1'], manualCounts: {} }, photoWindows: [photo('p1')] as never });
    expect(w).toEqual([]);
  });
  it('reads the estimated counts', () => {
    const counts = { small: { measured: 1, estimated: 2 }, standard: { measured: 0, estimated: 0 }, large: { measured: 0, estimated: 3 }, picture: { measured: 0, estimated: 0 } } as WindowCounts;
    expect(estimatedOf(counts)).toEqual({ small: 2, standard: 0, large: 3, picture: 0 });
  });
});

describe('lineOptionCents', () => {
  const white = { frameInterior: 'white', frameExterior: 'white', grid: { type: 'none', top: '', bottom: '' } } as const;
  it('adds nothing for white frames and no grid', () => expect(lineOptionCents(catalog.adders, white)).toBe(0));
  it('adds a coloured exterior, a woodgrain interior and a colonial grid', () => {
    expect(lineOptionCents(catalog.adders, { ...white, frameExterior: 'bronze' })).toBe(6_000);
    expect(lineOptionCents(catalog.adders, { ...white, frameInterior: 'woodgrain' })).toBe(8_500);
    expect(lineOptionCents(catalog.adders, { ...white, grid: { type: 'colonial', top: '3x2', bottom: '3x2' } })).toBe(3_500);
    expect(lineOptionCents(catalog.adders, { frameInterior: 'woodgrain', frameExterior: 'black', grid: { type: 'colonial', top: '3x2', bottom: '' } })).toBe(18_000);
  });
  it('leaves prairie and custom grids unpriced (Queen Anne has no grid type)', () => {
    expect(lineOptionCents(catalog.adders, { ...white, grid: { type: 'prairie', top: '3x2', bottom: '' } })).toBe(0);
  });
});
