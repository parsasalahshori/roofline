import { describe, expect, it } from 'vitest';
import {
  buildHomeownerQuote,
  catalogWindowCents,
  DEFAULT_WINDOW_CATALOG,
  publicFactsOf,
  resolveCatalog,
  tileOfStyle,
  type WindowCatalog,
  WindowCatalogSchema,
} from '../src/index.ts';

const catalog = (over: Partial<WindowCatalog> = {}): WindowCatalog => ({
  ...resolveCatalog(null),
  tiers: [
    { tier: 'good', label: 'Replenish', note: '1-year warranty', name: 'Economy', description: 'd', priceCents: { small: 40_000, standard: 50_000, large: 60_000, picture: 80_000 }, enabled: true },
    { tier: 'better', label: 'Refine', note: 'Lifetime warranty', name: 'Elite', description: 'd', priceCents: { small: 50_000, standard: 60_000, large: 70_000, picture: 90_000 }, enabled: true },
    { tier: 'best', name: 'Executive', description: 'd', priceCents: { small: 60_000, standard: 70_000, large: 80_000, picture: 100_000 }, enabled: true },
  ],
  styleAdjustCents: { sideways: { good: 2_000 }, fixed: { good: -9_000 } },
  adders: { ...DEFAULT_WINDOW_CATALOG.adders, frostedCents: 4_500 },
  ...over,
});

describe('window catalog', () => {
  it('has four plain tiles by default, and every window style is in exactly one', () => {
    const tiles = resolveCatalog(null).styleTiles;
    expect(tiles.map((t) => t.label)).toEqual(['Opens up and down', 'Slides sideways', "Doesn't open", 'Bay, bow or odd shape']);
    expect(tileOfStyle(tiles, 'slider-3').id).toBe('sideways');
    expect(tileOfStyle(tiles, 'double-hung').id).toBe('up-down');
    expect(tileOfStyle(tiles, 'circle').atVisit).toBe(true);
  });

  it('prices a window: base, plus the style move, plus frosted glass; nothing for a tile priced at the visit', () => {
    const c = catalog();
    const tile = (id: string) => c.styleTiles.find((t) => t.id === id)!;
    expect(catalogWindowCents(c, tile('up-down'), 'good', 'standard', false)).toBe(50_000);
    expect(catalogWindowCents(c, tile('sideways'), 'good', 'standard', false)).toBe(52_000);
    expect(catalogWindowCents(c, tile('fixed'), 'good', 'standard', true)).toBe(50_000 - 9_000 + 4_500);
    expect(catalogWindowCents(c, tile('special'), 'good', 'standard', true)).toBeNull();
  });

  it('puts the company\'s tier names and notes in the quote, and leaves bay and bow out of the total', () => {
    const q = buildHomeownerQuote({
      measured: [
        { id: 'a', sizeClass: 'standard', style: 'double-hung' },
        { id: 'b', sizeClass: 'standard', style: 'double-hung', frosted: true },
        { id: 'c', sizeClass: 'large', style: 'arch' },
      ],
      expected: null,
      override: null,
      mix: null,
      catalog: catalog(),
    });
    const good = q.tiers.find((t) => t.key === 'good')!;
    expect(good.label).toBe('Replenish');
    expect(good.note).toBe('1-year warranty');
    expect(good.perWindow).toEqual([{ windowId: 'a', price: 500 }, { windowId: 'b', price: 545 }, { windowId: 'c', price: 0, atVisit: true }]);
    expect(good.total).toBe(1045);
    // No label set: Good / Better / Best, and no note
    const best = q.tiers.find((t) => t.key === 'best')!;
    expect(best.label).toBe('Best');
    expect(best.note).toBe('');
    expect(q.atVisitCount).toBe(1);
  });

  it('prices without a catalog exactly as before, and leaves atVisitCount off', () => {
    const q = buildHomeownerQuote({ measured: [{ id: 'a', sizeClass: 'standard' }], expected: null, override: null, mix: null });
    expect(q.tiers.map((t) => [t.label, t.note, t.total])).toEqual([['Good', '', 600], ['Better', '', 800], ['Best', '', 1200]]);
    expect(q.atVisitCount).toBeUndefined();
  });

  it('shows no price in what the public pages are told', () => {
    const facts = publicFactsOf(catalog({ included: ['FlexScreen'] }));
    expect(facts.tiers).toEqual([
      { key: 'good', label: 'Replenish', note: '1-year warranty' },
      { key: 'better', label: 'Refine', note: 'Lifetime warranty' },
      { key: 'best', label: 'Best', note: '' },
    ]);
    expect(facts.tiles[0]).toEqual({ id: 'up-down', label: 'Opens up and down', hint: 'Double-hung', style: 'double-hung', atVisit: false });
    expect(JSON.stringify(facts)).not.toMatch(/priceCents|Cents/);
  });

  it('accepts the defaults and refuses a style in two choices, a link that is not https, and a fourth badge', () => {
    expect(WindowCatalogSchema.safeParse(resolveCatalog(null)).success).toBe(true);
    const twice = catalog({ styleTiles: [{ id: 'a', label: 'A', hint: '', styles: ['picture'], atVisit: false }, { id: 'b', label: 'B', hint: '', styles: ['picture'], atVisit: false }] });
    expect(WindowCatalogSchema.safeParse(twice).success).toBe(false);
    expect(WindowCatalogSchema.safeParse(catalog({ offer: { title: 'x', termsUrl: 'http://x.test' } })).success).toBe(false);
    expect(WindowCatalogSchema.safeParse(catalog({ trust: { rating: null, sinceYear: null, license: null, badges: ['a', 'b', 'c', 'd'] } })).success).toBe(false);
    expect(WindowCatalogSchema.safeParse(catalog({ trust: { rating: { value: 4.9, count: 2400, plus: true, source: 'homeowners' }, sinceYear: 2012, license: null, badges: ['A+ BBB'] } })).success).toBe(true);
  });
});
