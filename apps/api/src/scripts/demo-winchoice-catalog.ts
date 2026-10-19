import { getTierTemplates, saveTierTemplates, saveWindowCatalog, withTenant, type Pools, type TenantContext } from '@roofline/db';
import { DEFAULT_TIER_TEMPLATES, type WindowCatalog } from '@roofline/shared';

/*
 * WinChoice's window catalog for the demo: the names and facts are the company's own (winchoice.com, researched
 * 2026-10-17: the series Replenish / Refine / Renew, what every window includes, 4.9 from 2,400+ homeowners, the badges,
 * Skeps financing, the October offer). EVERY PRICE BELOW IS A MADE-UP DEMO NUMBER. WinChoice publishes no prices and
 * these are not its prices. Roof tiers carry the Malarkey line names.
 */

/** Cents. DEMO numbers, not WinChoice's real prices. */
const DEMO_BASE: Record<'good' | 'better' | 'best', { small: number; standard: number; large: number; picture: number }> = {
  good: { small: 38_000, standard: 49_000, large: 61_000, picture: 78_000 },
  better: { small: 52_000, standard: 65_000, large: 80_000, picture: 102_000 },
  best: { small: 69_000, standard: 86_000, large: 105_000, picture: 132_000 },
};

export const WINCHOICE_CATALOG: WindowCatalog = {
  styleTiles: [
    { id: 'up-down', label: 'Opens up and down', hint: 'Double-hung', styles: ['double-hung', 'single-hung'], atVisit: false },
    { id: 'sideways', label: 'Slides sideways', hint: 'Double sliding or 3-lite slider', styles: ['slider-2', 'slider-3'], atVisit: false },
    { id: 'fixed', label: "Doesn't open", hint: 'Picture window', styles: ['picture'], atVisit: false },
    { id: 'special', label: 'Bay, bow or odd shape', hint: 'We quote it at your visit', styles: ['arch', 'circle', 'casement', 'awning'], atVisit: true },
  ],
  tiers: [
    { tier: 'good', label: 'Replenish', note: '1-year warranty', name: 'Economy vinyl series', description: 'Argon-filled Low-E vinyl window', priceCents: DEMO_BASE.good, enabled: true },
    { tier: 'better', label: 'Refine', note: 'Lifetime warranty', name: 'Elite vinyl series', description: 'Argon-filled Low-E vinyl window', priceCents: DEMO_BASE.better, enabled: true },
    { tier: 'best', label: 'Renew', note: 'Lifetime warranty', name: 'Executive vinyl series', description: 'Argon-filled Low-E vinyl window', priceCents: DEMO_BASE.best, enabled: true },
  ],
  // DEMO numbers: sliders cost a little more than the double-hung base, a window that does not open a little less.
  styleAdjustCents: {
    sideways: { good: 2_000, better: 2_500, best: 3_000 },
    fixed: { good: -9_000, better: -11_000, best: -13_000 },
  },
  // DEMO numbers.
  adders: { frostedCents: 4_500, exteriorColorCents: 6_000, woodInteriorCents: 8_500, gridColonialCents: 3_500, gridQueenAnneCents: 5_500 },
  included: ['Argon gas fill', 'Low-E glass (Cardinal LoE366)', 'ENERGY STAR® certified', 'FlexScreen'],
  trust: {
    rating: { value: 4.9, count: 2400, plus: true, source: 'homeowners' },
    sinceYear: 2012,
    license: null,
    badges: ['A+ BBB', 'Made in USA', 'Lifetime warranty available'],
  },
  offer: { title: 'October special on windows and roofing. Ask about it at your visit.', termsUrl: 'https://winchoice.com/promotional-terms-conditions/' },
  financing: { text: 'Financing available through our partner Skeps. Optional, with no obligation.', url: 'https://winchoice.com/financing/' },
};

const ROOF_NAMES = {
  good: { name: 'Malarkey Highlander', highlights: ['Class 3 impact rated', '15-year algae warranty', 'Limited lifetime shingle warranty'] },
  better: { name: 'Malarkey Vista', highlights: ['Class 4 impact rated', '25-year algae warranty', 'Limited lifetime shingle warranty'] },
  best: { name: 'Malarkey Legacy', highlights: ['Class 4 impact rated', 'Limited lifetime algae warranty', '20-year non-prorated period'] },
} as const;

/** Stores the catalog and the Malarkey roof tiers when the company has none of its own yet. */
export async function seedWinChoiceCatalog(pools: Pools, ctx: TenantContext, now: Date): Promise<void> {
  await withTenant(pools, ctx, async (tx) => {
    await saveWindowCatalog(tx, ctx, WINCHOICE_CATALOG, now);
    if ((await getTierTemplates(tx, ctx)).isDefault) {
      await saveTierTemplates(
        tx,
        ctx,
        DEFAULT_TIER_TEMPLATES.map((t) => ({ ...t, addOns: t.addOns.map((a) => ({ ...a })), name: ROOF_NAMES[t.tier].name, highlights: [...ROOF_NAMES[t.tier].highlights] })),
        now,
      );
    }
  });
}
