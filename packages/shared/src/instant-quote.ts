import type { LngLat } from './roof.ts';

/*
 * Instant quote: the public page a company puts on its own website in place of its "free estimate" form
 * (route /q/:slug, API /api/public/quote/:slug). A homeowner types an address and sees price RANGES only, then
 * leaves their details. Nothing here is a price a company quotes: every number shown is widened and rounded.
 */

/** What a company can offer on its page, in the order the page lists them. */
export const QUOTE_PRODUCTS = ['windows', 'roof', 'gutters'] as const;
export type QuoteProduct = (typeof QUOTE_PRODUCTS)[number];

/**
 * What homeowners are offered (the web page and the app). Gutters are measured and priced by staff only, so they are
 * left out of everything a homeowner sees, whatever the company has switched on.
 */
export function homeownerProducts(products: readonly QuoteProduct[]): QuoteProduct[] {
  return products.filter((p) => p !== 'gutters');
}

/** Defaults for a company that has not set the page up yet. */
export const QUOTE_DEFAULTS = {
  products: ['windows', 'roof'] as QuoteProduct[],
  /** Range width each side of the middle price, percent (±12 %). */
  rangePct: 12,
  /** Fresh (uncached) measurements a day. Each one costs paid map calls. */
  dailyCap: 50,
} as const;

export const QUOTE_LIMITS = {
  rangePctMin: 5,
  rangePctMax: 40,
  dailyCapMax: 1000,
  maxOrigins: 10,
  originMax: 200,
  /** Days a measured address is kept and answered again from storage (Google's caching terms allow 30). */
  cacheDays: 30,
  /** The shortest time, in milliseconds, a person takes from opening the form to sending it; faster is a bot. */
  minFillMs: 3000,
} as const;

/** A page's slug: lowercase letters, digits and inner hyphens, 3 to 40 long. */
export const QUOTE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** A colour the page's buttons and header take: #rgb or #rrggbb. */
export const QUOTE_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** An embed origin: scheme and host (and port), nothing after. */
export const QUOTE_ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/**
 * The consent shown next to the two boxes. Changing these words means a new version: the server records the version
 * the page showed with the exact text of each box ticked, the time and a hash of the address the request came from.
 * 2026-10-16: one box became two, a required one for calls and email and an optional one for texts.
 */
export const QUOTE_CONSENT_VERSION = '2026-10-16';

/** The required box: calls and email about the estimate. Ticking it is required to send the form. */
export function quoteConsentText(companyName: string): string {
  return (
    `By checking this box and clicking "Send my request", I agree that ${companyName} may contact me about my estimate ` +
    'and appointment by phone call and email at the phone number and email I provided, including calls that may use ' +
    'automated technology or a prerecorded or artificial voice. Consent is not a condition of purchase. ' +
    'I agree to the Privacy Policy and Terms.'
  );
}

/** The optional box, unticked to start: text messages. Its sentence is kept only when it is ticked. */
export function quoteTextConsentText(companyName: string): string {
  return (
    `Text me too: ${companyName} may send text messages about my estimate and appointment to the phone number I ` +
    'provided, which may be sent using automated technology. Consent is not a condition of purchase. Message ' +
    'frequency varies. Message and data rates may apply. Reply STOP to stop texts or HELP for help.'
  );
}

/** A widened, rounded range. Cents, both multiples of $100. */
export type PriceRange = { lowCents: number; highCents: number };

const ROUND_CENTS = 10_000;

/**
 * The range shown for a set of option totals: the middle option (the recommended one when there are three; the
 * median otherwise) less and plus `pct` percent, rounded out to whole hundreds of dollars. Spanning the cheapest to
 * the dearest option gave ranges too wide to be useful (a $9,100-$23,300 window job). Null when there is nothing to
 * price.
 */
export function priceRange(totalsCents: readonly number[], pct: number): PriceRange | null {
  const ok = totalsCents.filter((c) => Number.isFinite(c) && c > 0).sort((a, b) => a - b);
  if (ok.length === 0) return null;
  const share = Math.min(Math.max(pct, 0), 90) / 100;
  const mid = ok.length % 2 === 1 ? ok[(ok.length - 1) / 2]! : (ok[ok.length / 2 - 1]! + ok[ok.length / 2]!) / 2;
  // Whole cents first: 1,500,000 x 1.1 is 1,650,000.0000000002 in floating point, which would round out a step too far.
  const low = Math.round(mid * (1 - share));
  const high = Math.round(mid * (1 + share));
  const lowCents = Math.max(ROUND_CENTS, Math.floor(low / ROUND_CENTS) * ROUND_CENTS);
  const highCents = Math.max(lowCents + ROUND_CENTS, Math.ceil(high / ROUND_CENTS) * ROUND_CENTS);
  return { lowCents, highCents };
}

/** The page's settings as the owner edits them (GET/PUT /api/company/instant-quote). */
export type InstantQuoteSettings = {
  enabled: boolean;
  slug: string | null;
  products: QuoteProduct[];
  rangePct: number;
  dailyCap: number;
  embedOrigins: string[];
  booking: boolean;
  accentColor: string | null;
};

/** GET /api/public/quote/:slug. */
export type PublicQuoteConfig = {
  slug: string;
  companyName: string;
  logoUrl: string | null;
  accentColor: string | null;
  /** The company's phone, for "we'll call you" and the confirmation; E.164 or null. */
  phone: string | null;
  products: QuoteProduct[];
  booking: boolean;
  /**
   * `text`: the required calls-and-email box; `textingText`: the optional "text me" box; the company's privacy and
   * terms pages, linked under the boxes.
   */
  consent: { version: string; text: string; textingText: string; privacyUrl: string; termsUrl: string };
  /** Cloudflare Turnstile site key when the page asks for it; null when it does not. */
  turnstileSiteKey: string | null;
  /**
   * The company's phone app for measuring windows (the homeowner API): where to get it (the App Store link, from the
   * server's HOMEOWNER_APP_URL) and its name. Null when the server has none set: the page then offers only the free visit.
   */
  homeownerApp: { url: string; name: string } | null;
};

/**
 * What the homeowner is told when the satellite pictures of their home cannot be trusted to measure the roof (too old,
 * not sharp enough, no building found, or the roof outline is in doubt). The specific cause is kept for staff only.
 */
export const SATELLITE_UNUSABLE_MESSAGE =
  "We can't measure your roof from satellite images — the pictures of your home aren't clear or recent enough. We'll measure it at your free visit.";

/** How the estimate came out: measured, or the company's daily limit reached / the home not measurable (we call instead). */
export type PublicQuoteStatus = 'ready' | 'fallback';

/** POST /api/public/quote/:slug/estimate. Ranges only, never a price list or a single price. */
export type PublicQuoteEstimate = {
  quoteId: string;
  status: PublicQuoteStatus;
  /** The address as found (street, city, state and ZIP), or as typed when it was not looked up. */
  address: string;
  roof: { squares: number; range: PriceRange } | null;
  /**
   * The window count is a guess from the outside: `count` is the likely number, `countRange` the plausible low to high
   * (equal when the walls are clear). The web page shows the count only; the price stays with staff and the app.
   */
  windows: { count: number; range: PriceRange; countRange: { low: number; high: number } } | null;
  /** Always null since October 2026: gutters are priced at the visit, never on the page (kept for older stored rows). */
  gutters: { feet: number; range: PriceRange } | null;
  /** The main roof's outline for the picture, and the point the picture is centred on. */
  outline: { center: LngLat; ring: LngLat[] } | null;
  /** 'satellite-unusable': the roof is not priced because the satellite pictures cannot be trusted (see SATELLITE_UNUSABLE_MESSAGE). */
  notice?: 'satellite-unusable' | null;
};

/** GET /api/public/quote/:slug/slots: open in-home visit times. `id` is the start as an ISO string. */
export type PublicQuoteSlot = { id: string; start: string; end: string };
export type PublicQuoteSlots = { timeZone: string; slots: PublicQuoteSlot[] };

/** The window counts a homeowner may set on the page. */
export const QUOTE_WINDOW_COUNT = { min: 1, max: 80 } as const;

/** POST /api/public/quote/:slug/windows { quoteId, count } answer: the windows range for that count. */
export type PublicQuoteWindows = { count: number; range: PriceRange };

/**
 * POST /api/public/quote/:slug/lead answer. `booked`: the visit booked (or already booked by an earlier send of the
 * same request). `slotTaken`: a time was picked but could not be booked (taken meanwhile): the office calls instead.
 */
export type PublicQuoteLeadResult = { ok: true; booked: { start: string; end: string } | null; slotTaken?: boolean };
