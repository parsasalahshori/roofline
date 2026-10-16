import type { LngLat } from './roof.ts';

/*
 * Instant quote: the public page a company puts on its own website in place of its "free estimate" form
 * (route /q/:slug, API /api/public/quote/:slug). A homeowner types an address and sees price RANGES only, then
 * leaves their details. Nothing here is a price a company quotes: every number shown is widened and rounded.
 */

/** What a company can offer on its page, in the order the page lists them. */
export const QUOTE_PRODUCTS = ['windows', 'roof', 'gutters'] as const;
export type QuoteProduct = (typeof QUOTE_PRODUCTS)[number];

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
 * The consent shown next to the box. Changing these words means a new version: the server records the version the
 * page showed with its exact text, the time and a hash of the address the request came from.
 */
export const QUOTE_CONSENT_VERSION = '2026-10-15';

/** The full consent sentence for one company. Ticking it is required to send the form. */
export function quoteConsentText(companyName: string): string {
  return (
    `By checking this box and clicking "Get my estimate", I agree that ${companyName} may contact me about my estimate ` +
    'and appointment at the phone number and email I provided, including by calls and text messages that may be sent ' +
    'using automated technology or prerecorded or artificial voices. Consent is not a condition of purchase. ' +
    'Message frequency varies. Message and data rates may apply. Reply STOP to stop texts or HELP for help. ' +
    'I also agree to the Privacy Policy and Terms.'
  );
}

/** A widened, rounded range. Cents, both multiples of $100. */
export type PriceRange = { lowCents: number; highCents: number };

const ROUND_CENTS = 10_000;

/**
 * The range shown for a set of option totals: the cheapest less `pct` percent to the dearest plus `pct` percent,
 * rounded out to whole hundreds of dollars. Null when there is nothing to price.
 */
export function priceRange(totalsCents: readonly number[], pct: number): PriceRange | null {
  const ok = totalsCents.filter((c) => Number.isFinite(c) && c > 0);
  if (ok.length === 0) return null;
  const share = Math.min(Math.max(pct, 0), 90) / 100;
  const low = Math.min(...ok) * (1 - share);
  const high = Math.max(...ok) * (1 + share);
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
  consent: { version: string; text: string };
  /** Cloudflare Turnstile site key when the page asks for it; null when it does not. */
  turnstileSiteKey: string | null;
};

/** How the estimate came out: measured, or the company's daily limit reached / the home not measurable (we call instead). */
export type PublicQuoteStatus = 'ready' | 'fallback';

/** POST /api/public/quote/:slug/estimate. Ranges only, never a price list or a single price. */
export type PublicQuoteEstimate = {
  quoteId: string;
  status: PublicQuoteStatus;
  /** The address as found (street, city, state and ZIP), or as typed when it was not looked up. */
  address: string;
  roof: { squares: number; range: PriceRange } | null;
  windows: { count: number; range: PriceRange } | null;
  gutters: { feet: number; range: PriceRange } | null;
  /** The main roof's outline for the picture, and the point the picture is centred on. */
  outline: { center: LngLat; ring: LngLat[] } | null;
};

/** GET /api/public/quote/:slug/slots: open in-home visit times. `id` is the start as an ISO string. */
export type PublicQuoteSlot = { id: string; start: string; end: string };
export type PublicQuoteSlots = { timeZone: string; slots: PublicQuoteSlot[] };

/** POST /api/public/quote/:slug/lead answer. */
export type PublicQuoteLeadResult = { ok: true; booked: { start: string; end: string } | null };
