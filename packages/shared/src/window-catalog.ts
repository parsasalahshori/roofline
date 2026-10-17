import { z } from 'zod';
import { TIERS } from './proposals.ts';
import type { Tier } from './proposals.ts';
import { WINDOW_STYLES } from './window-order.ts';
import type { WindowStyle } from './window-order.ts';
import { DEFAULT_WINDOW_TIERS, WINDOW_SIZE_CLASSES } from './windows.ts';
import type { WindowSizeClass, WindowTier } from './windows.ts';

/*
 * A company's window catalog: what a homeowner is offered and what it costs, in one record kept in the company's
 * settings (company_settings.window_catalog; null = the defaults below).
 *
 * - Style tiles: the plain choices a homeowner sees ("Opens up and down") and the window styles (the factory order's
 *   keys) each one stands for. The first style of a tile is the one the apps send.
 * - Tiers: Good / Better / Best with the company's own label and a one-line note, and the base price per window by size
 *   class (WindowTier, as before). A tile's price moves from that base by `styleAdjustCents`.
 * - Adders: frosted glass (asked on the page), and the options chosen at the visit (colour, wood-look interior, grids).
 * - Facts the homeowner pages show: what every window includes, trust facts and badges, an offer banner, a financing line.
 */

export const WINDOW_CATALOG_LIMITS = {
  tiles: 6,
  tileLabel: 40,
  tileHint: 60,
  tierLabel: 30,
  tierNote: 80,
  included: 8,
  includedItem: 60,
  badges: 3,
  badgeItem: 24,
  offerTitle: 80,
  financingText: 120,
  url: 300,
  adderCentsMax: 1_000_000,
  priceCentsMax: 10_000_000,
} as const;

/** A plain choice for the homeowner and the window styles it stands for. */
export type StyleTile = {
  /** Stable key (lowercase letters, digits, dashes). */
  id: string;
  label: string;
  /** A few words under the label. */
  hint: string;
  /** The window styles this tile covers; the first is the one an app sends. */
  styles: WindowStyle[];
  /** True: counted, but priced by the company at the visit (no instant price). */
  atVisit: boolean;
};

export const DEFAULT_STYLE_TILES: readonly StyleTile[] = [
  { id: 'up-down', label: 'Opens up and down', hint: 'Double-hung', styles: ['double-hung', 'single-hung'], atVisit: false },
  { id: 'sideways', label: 'Slides sideways', hint: 'Slider', styles: ['slider-2', 'slider-3'], atVisit: false },
  { id: 'fixed', label: "Doesn't open", hint: 'Picture window', styles: ['picture'], atVisit: false },
  { id: 'special', label: 'Bay, bow or odd shape', hint: 'We quote it at your visit', styles: ['arch', 'circle', 'casement', 'awning'], atVisit: true },
];

/** Cents added per window. Frosted glass is asked on the page; the rest are chosen at the visit. */
export type WindowAdders = {
  frostedCents: number;
  exteriorColorCents: number;
  woodInteriorCents: number;
  gridColonialCents: number;
  gridQueenAnneCents: number;
};

export const ADDER_KEYS = ['frostedCents', 'exteriorColorCents', 'woodInteriorCents', 'gridColonialCents', 'gridQueenAnneCents'] as const satisfies readonly (keyof WindowAdders)[];

export type CatalogRating = {
  /** 1 to 5. */
  value: number;
  /** How many it is over. */
  count: number;
  /** Shown as "2,400+" when true. */
  plus: boolean;
  /** Free text after the count: "homeowners", "Google reviews". */
  source: string;
};

export type CatalogTrust = {
  rating: CatalogRating | null;
  sinceYear: number | null;
  license: { state: string; number: string } | null;
  /** Up to three short badges: "A+ BBB", "Made in USA". */
  badges: string[];
};

export type CatalogOffer = { title: string; termsUrl: string | null };
export type CatalogFinancing = { text: string; url: string | null };

export type WindowCatalog = {
  styleTiles: StyleTile[];
  /** Per tier: the company's label and note, and the base price per size class. */
  tiers: WindowTier[];
  /** By tile id then tier: cents added to (or taken off) the base price for that style. Missing = 0. */
  styleAdjustCents: Record<string, Partial<Record<Tier, number>>>;
  adders: WindowAdders;
  /** "Every window includes". */
  included: string[];
  trust: CatalogTrust;
  offer: CatalogOffer | null;
  financing: CatalogFinancing | null;
};

export const DEFAULT_ADDERS: WindowAdders = { frostedCents: 0, exteriorColorCents: 0, woodInteriorCents: 0, gridColonialCents: 0, gridQueenAnneCents: 0 };

export const DEFAULT_WINDOW_CATALOG: WindowCatalog = {
  styleTiles: DEFAULT_STYLE_TILES.map((t) => ({ ...t, styles: [...t.styles] })),
  tiers: DEFAULT_WINDOW_TIERS.map((t) => ({ ...t, priceCents: { ...t.priceCents } })),
  styleAdjustCents: {},
  adders: { ...DEFAULT_ADDERS },
  included: [],
  trust: { rating: null, sinceYear: null, license: null, badges: [] },
  offer: null,
  financing: null,
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Validation                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

const L = WINDOW_CATALOG_LIMITS;
const text = (max: number) => z.string().trim().min(1).max(max);
const cents = (max: number) => z.number().int().min(0).max(max);
const url = z
  .string()
  .trim()
  .max(L.url)
  .regex(/^https:\/\/[^\s]+$/, 'Use a web address that starts with https://');

const StyleTileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/),
  label: text(L.tileLabel),
  hint: z.string().trim().max(L.tileHint),
  styles: z.array(z.enum(WINDOW_STYLES)).min(1).max(WINDOW_STYLES.length),
  atVisit: z.boolean(),
});

const WindowTierSchema = z.object({
  tier: z.enum(TIERS),
  name: text(60),
  description: z.string().trim().max(120),
  label: text(L.tierLabel).optional(),
  note: z.string().trim().max(L.tierNote).optional(),
  priceCents: z.object(Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, cents(L.priceCentsMax)])) as Record<WindowSizeClass, z.ZodNumber>),
  enabled: z.boolean(),
});

const AddersSchema = z.object(Object.fromEntries(ADDER_KEYS.map((k) => [k, cents(L.adderCentsMax)])) as Record<keyof WindowAdders, z.ZodNumber>).strict();

export const WindowCatalogSchema: z.ZodType<WindowCatalog> = z
  .object({
    styleTiles: z.array(StyleTileSchema).min(1).max(L.tiles),
    tiers: z.array(WindowTierSchema).length(TIERS.length),
    styleAdjustCents: z.record(z.string(), z.object(Object.fromEntries(TIERS.map((t) => [t, z.number().int().min(-L.priceCentsMax).max(L.priceCentsMax).optional()]))).partial()),
    adders: AddersSchema,
    included: z.array(text(L.includedItem)).max(L.included),
    trust: z.object({
      rating: z
        .object({
          value: z.number().min(1).max(5),
          count: z.number().int().min(1).max(10_000_000),
          plus: z.boolean(),
          source: text(30),
        })
        .nullable(),
      sinceYear: z.number().int().min(1900).max(2100).nullable(),
      license: z.object({ state: z.string().trim().length(2), number: text(24) }).nullable(),
      badges: z.array(text(L.badgeItem)).max(L.badges),
    }),
    offer: z.object({ title: text(L.offerTitle), termsUrl: url.nullable() }).nullable(),
    financing: z.object({ text: text(L.financingText), url: url.nullable() }).nullable(),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    const styles = new Set<WindowStyle>();
    c.styleTiles.forEach((t, i) => {
      if (ids.has(t.id)) ctx.addIssue({ code: 'custom', path: ['styleTiles', i, 'id'], message: 'Each choice needs its own id.' });
      ids.add(t.id);
      for (const s of t.styles) {
        if (styles.has(s)) ctx.addIssue({ code: 'custom', path: ['styleTiles', i, 'styles'], message: 'A window style can be in one choice only.' });
        styles.add(s);
      }
    });
    if (!TIERS.every((tier) => c.tiers.filter((t) => t.tier === tier).length === 1)) ctx.addIssue({ code: 'custom', path: ['tiers'], message: 'One entry per tier.' });
  });

/**
 * A stored catalog (possibly partial or null) as a whole one: every missing part falls back to the default. Never
 * throws; the stored value was checked on save.
 */
export function resolveCatalog(stored: Partial<WindowCatalog> | null | undefined): WindowCatalog {
  const d = DEFAULT_WINDOW_CATALOG;
  if (stored === null || stored === undefined) return { ...d, styleTiles: d.styleTiles.map((t) => ({ ...t, styles: [...t.styles] })), tiers: d.tiers.map((t) => ({ ...t, priceCents: { ...t.priceCents } })) };
  const tiers = TIERS.map((tier) => {
    const base = d.tiers.find((t) => t.tier === tier)!;
    const mine = stored.tiers?.find((t) => t.tier === tier);
    return mine === undefined ? { ...base, priceCents: { ...base.priceCents } } : { ...base, ...mine, priceCents: { ...base.priceCents, ...mine.priceCents } };
  });
  return {
    styleTiles: stored.styleTiles !== undefined && stored.styleTiles.length > 0 ? stored.styleTiles : d.styleTiles.map((t) => ({ ...t, styles: [...t.styles] })),
    tiers,
    styleAdjustCents: stored.styleAdjustCents ?? {},
    adders: { ...d.adders, ...(stored.adders ?? {}) },
    included: stored.included ?? [],
    trust: { ...d.trust, ...(stored.trust ?? {}) },
    offer: stored.offer ?? null,
    financing: stored.financing ?? null,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reading it                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The tile a window style belongs to; the first tile when no tile lists it (an old style key). */
export function tileOfStyle(tiles: readonly StyleTile[], style: WindowStyle): StyleTile {
  return tiles.find((t) => t.styles.includes(style)) ?? tiles[0]!;
}

/** The base tile: the first one (the plain, priced one the unmeasured windows use). */
export const baseTile = (tiles: readonly StyleTile[]): StyleTile => tiles[0]!;

/**
 * What one window of a size on a tier costs, in cents: the tier's base price for the size, plus the style's move from
 * it, plus frosted glass when asked. Null for a tile priced at the visit. Never below zero.
 */
export function catalogWindowCents(catalog: WindowCatalog, tile: StyleTile, tier: Tier, sizeClass: WindowSizeClass, frosted: boolean): number | null {
  if (tile.atVisit) return null;
  const t = catalog.tiers.find((x) => x.tier === tier);
  if (t === undefined) return null;
  const adjust = catalog.styleAdjustCents[tile.id]?.[tier] ?? 0;
  return Math.max(0, t.priceCents[sizeClass] + adjust + (frosted ? catalog.adders.frostedCents : 0));
}

/** The tiers as WindowTier list for priceWindows (staff): base prices with the label and note. */
export const catalogTiers = (catalog: WindowCatalog): WindowTier[] => catalog.tiers;

/** The default Good / Better / Best words. */
export const TIER_RANK_WORDS: Readonly<Record<Tier, string>> = { good: 'Good', better: 'Better', best: 'Best' };

/* ------------------------------------------------------------------------------------------------------------------ */
/* What the public pages and the app are told                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A style tile as a homeowner's client uses it: `style` is the key it sends for the window. */
export type PublicStyleTile = { id: string; label: string; hint: string; style: WindowStyle; atVisit: boolean };

/** The catalog's words and facts, with no prices: in GET /api/public/quote/:slug and the homeowner API's /company. */
export type PublicCatalogFacts = {
  tiles: PublicStyleTile[];
  tiers: { key: Tier; label: string; note: string }[];
  included: string[];
  trust: CatalogTrust;
  offer: CatalogOffer | null;
  financing: CatalogFinancing | null;
};

export function publicFactsOf(catalog: WindowCatalog): PublicCatalogFacts {
  return {
    tiles: catalog.styleTiles.map((t) => ({ id: t.id, label: t.label, hint: t.hint, style: t.styles[0]!, atVisit: t.atVisit })),
    tiers: catalog.tiers.filter((t) => t.enabled).map((t) => ({ key: t.tier, label: t.label ?? TIER_RANK_WORDS[t.tier], note: t.note ?? '' })),
    included: [...catalog.included],
    trust: { ...catalog.trust, badges: [...catalog.trust.badges] },
    offer: catalog.offer,
    financing: catalog.financing,
  };
}
