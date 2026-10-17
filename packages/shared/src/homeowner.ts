import type { QuoteProduct } from './instant-quote.ts';
import type { LngLat } from './roof.ts';
import type { WindowStyle } from './window-order.ts';
import type { ArDevice, ArQuad, Quad } from './window-photo-math.ts';
import { DEFAULT_WINDOW_CATALOG, catalogWindowCents, type PublicCatalogFacts, tileOfStyle, TIER_RANK_WORDS, type WindowCatalog } from './window-catalog.ts';
import { type RoomPlanConfidence, WINDOW_SIZE_CLASSES, type WindowSizeClass, type WindowTier } from './windows.ts';

/*
 * The homeowner API: what the homeowner's phone app (WinChoice, on iPhone) says to the server and gets back, under
 * /api/public/homeowner/:slug. Signed out; one request per homeowner, with its own bearer token. The contract in words,
 * with every endpoint and error, is docs/windows/homeowner-api.md; these are its types, shared by the server, the tests
 * and the web app. Money is whole US dollars (integers), sizes are inches.
 */

/** A bearer token lasts this many days from the request it was made with. */
export const HOMEOWNER_TOKEN_DAYS = 60;
/** The token as the app sends it: 32 random bytes in base64url (43 characters, no padding). */
export const HOMEOWNER_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Most windows one request may hold (the same limit as a staff measurement's photographed windows). */
export const HOMEOWNER_MAX_WINDOWS = 60;
/** Most photos one request may hold (a few spare for retakes). */
export const HOMEOWNER_MAX_UPLOADS = 90;
/** Most bytes of photos one request may hold. */
export const HOMEOWNER_MAX_UPLOAD_BYTES_TOTAL = 250 * 1024 * 1024;
/** One photo: 12 MB (the same limit as staff window photos). */
export const HOMEOWNER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const HOMEOWNER_ROOM_MAX = 40;
export const HOMEOWNER_LABEL_MAX = 80;

/**
 * Why a request went to the call-back path instead of getting an online estimate. Coarse on purpose (the app words each
 * one): 'unit' = an apartment, suite or other unit; 'address' = the address could not be pinned to one house; 'home' = a
 * house a person has to look at (a big building, a roof that is hard to see); 'busy' = nothing could be measured right
 * now (the company's daily limit, or the address lookup was down); 'satellite-unusable' = the satellite pictures of the
 * home are not clear or recent enough to measure the roof (the detailed reason stays with the company's staff).
 */
export const HOMEOWNER_CALLBACK_REASONS = ['unit', 'address', 'home', 'busy', 'satellite-unusable'] as const;
export type HomeownerCallbackReason = (typeof HOMEOWNER_CALLBACK_REASONS)[number];

/** Where a request is on its way from "asked" to "installed" (GET /requests/:id/status). */
export const HOMEOWNER_STAGES = ['requested', 'visit-booked', 'measured', 'ordered', 'built', 'shipped', 'installed'] as const;
export type HomeownerStage = (typeof HOMEOWNER_STAGES)[number];

export const HOMEOWNER_TIER_KEYS = ['good', 'better', 'best'] as const;
export type HomeownerTierKey = (typeof HOMEOWNER_TIER_KEYS)[number];

/** The window styles a homeowner may pick, with plain names (the keys are the factory order's styles). */
export const HOMEOWNER_WINDOW_STYLE_LABELS: Readonly<Record<WindowStyle, string>> = {
  'double-hung': 'Double-hung',
  'single-hung': 'Single-hung',
  'slider-2': 'Slider, 2 panes',
  'slider-3': 'Slider, 3 panes',
  picture: 'Picture (does not open)',
  casement: 'Casement (cranks open)',
  awning: 'Awning (tilts out)',
  arch: 'Arch top',
  circle: 'Round',
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Sizes in words                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * Inches as a whole number and a fraction in eighths: 35.625 is "35 5/8", 36 is "36", 0.5 is "1/2". `nearest` (the
 * default) rounds to the closest eighth; `up` rounds to the next eighth up, for a ± that must never be understated.
 */
export function inchesInEighths(inches: number, round: 'nearest' | 'up' = 'nearest'): string {
  const v = Math.max(0, inches);
  const eighths = round === 'up' ? Math.ceil(v * 8 - 1e-9) : Math.round(v * 8);
  const whole = Math.floor(eighths / 8);
  const rest = eighths - whole * 8;
  if (rest === 0) return String(whole);
  const g = gcd(rest, 8);
  const fraction = `${rest / g}/${8 / g}`;
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

/** "35 5/8 x 59 5/8": width then height, to the nearest eighth of an inch. */
export function windowSizeLabel(widthIn: number, heightIn: number): string {
  return `${inchesInEighths(widthIn)} x ${inchesInEighths(heightIn)}`;
}

/** "about ±1/8 in": the larger of the two ± values, rounded UP to an eighth (never less than 1/8), never a bare ±. */
export function windowUncertaintyLabel(uncertaintyIn: { width: number; height: number }): string {
  const worst = Math.max(uncertaintyIn.width, uncertaintyIn.height, 0.125);
  return `about ±${inchesInEighths(worst, 'up')} in`;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The contract                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * A choice on the window-style step: `key` is the style the app sends for it (the first of the choice's styles), `label`
 * the plain words ("Opens up and down"), `hint` a few words under it, `tile` its id. `atVisit`: the window is counted
 * but has no instant price (bay, bow and odd shapes).
 */
export type HomeownerWindowStyleOption = { key: WindowStyle; label: string; hint: string; tile: string; atVisit: boolean };

/** GET /company. */
export type HomeownerCompany = {
  /** The contract's version; changes only when something an old app relies on changes. */
  apiVersion: 1;
  name: string;
  /** The company's brand colour (#rrggbb), when it set one. */
  brandColor: string | null;
  /** E.164, for "call us". */
  phone: string | null;
  /** What the company offers, in the order the app lists them. */
  services: QuoteProduct[];
  /** True when the app may offer visit times (GET .../slots has some); false: only "call me". */
  booking: boolean;
  privacyUrl: string;
  termsUrl: string;
  /**
   * The words to show next to the two boxes on the contact screen, verbatim, and their version, which POST .../contact
   * must send back (the server stores the version and the exact sentences the person ticked).
   */
  consent: { version: string; text: string; textingText: string };
  windowStyles: HomeownerWindowStyleOption[];
  /**
   * What the company says about itself: a rating over a count with free-text source ("4.9 from 2,400+ homeowners"), the
   * year it started, a licence, and up to three short badges. Null when the company entered none of it.
   */
  trust: PublicCatalogFacts['trust'] | null;
  /** The tiers' own names and one-line notes, what every window includes, and the optional offer and financing lines. */
  catalog: Pick<PublicCatalogFacts, 'tiers' | 'included' | 'offer' | 'financing'>;
  limits: { maxWindows: number; maxPhotoBytes: number; maxRoomLength: number; maxLabelLength: number; tokenDays: number };
};

/** What the address said about the home, for the app's result screens. */
export type HomeownerHome = {
  /** The address as found (street, city, state, ZIP), or as typed when it could not be looked up. */
  address: string;
  /** Floors above ground, when known (1, 2 or 3; 1.5 is a storey and a half). */
  floors: number | null;
  /** The main roof's outline ([longitude, latitude]) and its middle, to draw on the app's own map; null when unknown. */
  outline: { center: LngLat; ring: LngLat[] } | null;
};

/** The estimates for the services asked about; null where the service was not asked about or could not be estimated. */
export type HomeownerEstimate = {
  /** How many windows the house probably has, counted from above: a plausible range and the number the quote uses. */
  windows: { low: number; high: number; likely: number } | null;
  /** The roof's price range, whole dollars (rounded out to hundreds), and its size in squares. */
  roof: { low: number; high: number; squares: number } | null;
  /**
   * Present when the roof was asked about but the satellite pictures cannot be trusted for this home: `roof` is then
   * null, no roof price is shown, and `message` is the sentence to show. The windows are not affected.
   */
  roofNote?: { reason: 'satellite-unusable'; message: string };
};

/** POST /requests. */
export type HomeownerCreated = {
  requestId: string;
  /** The bearer token for every call about this request. Shown once; the server keeps only its hash. */
  token: string;
  expiresAt: string;
  status: 'ready' | 'callback';
  callbackReason?: HomeownerCallbackReason;
  home: HomeownerHome;
  estimate: HomeownerEstimate;
  services: QuoteProduct[];
};

export type HomeownerArScale = { kind: 'ar'; pointsM: ArQuad; trackingLostCount: number; device: ArDevice; cornerSpreadM?: [number, number, number, number] };
export type HomeownerRoomPlanScale = { kind: 'roomplan'; widthM: number; heightM: number; confidence: RoomPlanConfidence };
export type HomeownerCardScale = { kind: 'card'; cardCorners: Quad; card: { widthMm: number; heightMm: number } };

/**
 * POST /requests/:id/windows. `uploadId` and `corners` (the window frame's four corners in that photo, top-left,
 * top-right, bottom-right, bottom-left, in the photo's pixels as displayed) are required for 'ar' and 'card'.
 */
export type HomeownerWindowInput = {
  id: string;
  room: string;
  label?: string;
  style: WindowStyle;
  /** Bathroom window: frosted (privacy) glass, which adds to the price. Absent: false. */
  frosted?: boolean;
  scale: HomeownerArScale | HomeownerRoomPlanScale | HomeownerCardScale;
  uploadId?: string;
  corners?: Quad;
};

/** A window as the server sized it. */
export type HomeownerWindow = HomeownerWindowInput & {
  /** Inches, to the nearest 1/100 (AR) or 1/10 (the others). */
  widthIn: number;
  heightIn: number;
  sizeClass: WindowSizeClass;
  /** About 1 sigma, inches. */
  uncertaintyIn: { width: number; height: number };
  quality: 'good' | 'check';
  /** Why 'check', in plain words to show the homeowner; empty when good. */
  reasons: string[];
  /** "35 5/8 x 59 5/8" (eighths of an inch). */
  sizeLabel: string;
  /** "about ±1/8 in" (rounded up to an eighth, never a bare ±). */
  uncertaintyLabel: string;
  /** The plain name of the window's style choice ("Opens up and down"). */
  styleLabel: string;
};

export type HomeownerQuoteTier = {
  key: HomeownerTierKey;
  /** The company's name for the tier ("Replenish"); "Good", "Better" or "Best" when it set none. */
  label: string;
  /** One line about the tier ("Lifetime warranty"); empty when the company set none. */
  note: string;
  /** What the tier is ("Vinyl double-hung") and a line about it. */
  name: string;
  description: string;
  /** Whole dollars, installed: every measured window plus the estimated ones. total = sum(perWindow) + estimatedTotal. */
  total: number;
  /** `atVisit`: this window has no instant price (price is 0 and it is left out of the total). */
  perWindow: { windowId: string; price: number; atVisit?: boolean }[];
  estimatedCount: number;
  estimatedTotal: number;
};

/** Shown when the homeowner has measured fewer windows than the address estimate expects ("Did we miss any?"). */
export type HomeownerMissingHint = { measured: number; expectedLow: number; expectedHigh: number; expectedLikely: number; text: string };

export type HomeownerQuote = {
  tiers: HomeownerQuoteTier[];
  measuredCount: number;
  /** Windows not measured yet, priced from the address estimate (or from the count the homeowner gave). */
  estimatedCount: number;
  /** Measured windows with no instant price (bay, bow, odd shapes): counted, priced at the visit. */
  atVisitCount?: number;
  missingHint?: HomeownerMissingHint;
};

/** GET /requests/:id/status. */
export type HomeownerStatus = {
  stage: HomeownerStage;
  /** ISO times for the stages reached; null for the ones not reached. */
  dates: { requestedAt: string | null; visit: string | null; measuredAt: string | null; orderedAt: string | null; installedAt: string | null };
  /** The rep for the visit, first name only. */
  rep?: { name: string };
  timeZone: string;
};

export type HomeownerBooking = { visit: { start: string; end: string; timeZone: string } | null; callMe: boolean };

/** What a request is, as GET /requests/:id and every change answer it. */
export type HomeownerRequestSummary = {
  id: string;
  status: 'ready' | 'callback';
  callbackReason?: HomeownerCallbackReason;
  services: QuoteProduct[];
  home: HomeownerHome;
  estimate: HomeownerEstimate;
  /** The number of windows the homeowner says the house has, when they said. */
  estimatedTotalOverride: number | null;
  /** True once POST .../contact filed the request with the company. */
  contactFiled: boolean;
  createdAt: string;
  expiresAt: string;
};

/** GET /requests/:id, and the answer to every change to the request (windows, the window count). */
export type HomeownerRequestView = {
  request: HomeownerRequestSummary;
  windows: HomeownerWindow[];
  /** The rooms used so far, in the order they were first used. */
  rooms: string[];
  /** Null when the request is not about windows, or went to the call-back path. */
  quote: HomeownerQuote | null;
  /** Present once the homeowner asked for a visit time or a call (POST .../book). */
  booking?: HomeownerBooking;
  /** Present once the request was filed (POST .../contact). */
  status?: HomeownerStatus;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* The quote                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

export type WindowMixCounts = Record<WindowSizeClass, number>;

/**
 * `mix` scaled to `count` windows in all, keeping its shares (largest remainders, so the parts add up); all 'standard'
 * when there is no mix.
 */
export function scaleWindowMix(mix: Partial<WindowMixCounts> | null, count: number): WindowMixCounts {
  const base = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, Math.max(0, Math.round(mix?.[c] ?? 0))])) as WindowMixCounts;
  const total = WINDOW_SIZE_CLASSES.reduce((n, c) => n + base[c], 0);
  if (total === 0) return { small: 0, standard: count, large: 0, picture: 0 };
  const exact = WINDOW_SIZE_CLASSES.map((c) => ({ c, v: (base[c] * count) / total }));
  const out = Object.fromEntries(exact.map(({ c, v }) => [c, Math.floor(v)])) as WindowMixCounts;
  let left = count - WINDOW_SIZE_CLASSES.reduce((n, c) => n + out[c], 0);
  for (const { c } of [...exact].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)))) {
    if (left <= 0) break;
    out[c] += 1;
    left -= 1;
  }
  return out;
}

const TIER_LABELS = TIER_RANK_WORDS;

export type HomeownerQuoteInput = {
  /** The windows the homeowner measured (each priced at its own size class). */
  measured: readonly { id: string; sizeClass: WindowSizeClass; style?: WindowStyle; frosted?: boolean }[];
  /** The address estimate's window count, or null when there is none. */
  expected: { low: number; high: number; likely: number } | null;
  /** The number of windows the homeowner says the house has (measured ones included), or null. */
  override: number | null;
  /** The address estimate's mix of sizes (counts or shares), used to price the windows not measured yet. */
  mix: Partial<WindowMixCounts> | null;
  /** The company's window catalog (tiers, style prices, frosted glass); the defaults when absent. */
  catalog?: WindowCatalog;
  /** Just the tiers, when there is no catalog (older callers). */
  tiers?: readonly WindowTier[];
};

/**
 * Good, Better and Best for a homeowner's request: every measured window at its own size's installed price, and the
 * windows not measured yet (the expected total less the measured ones, never below zero) at the address estimate's mix
 * of sizes. Whole US dollars; `total = sum(perWindow) + estimatedTotal` on every tier. The expected total is the
 * homeowner's own count when they gave one, else the address estimate's `likely`, else just what was measured.
 */
export function buildHomeownerQuote(input: HomeownerQuoteInput): HomeownerQuote {
  const measuredCount = input.measured.length;
  const expectedTotal = input.override ?? input.expected?.likely ?? measuredCount;
  const estimatedCount = Math.max(0, expectedTotal - measuredCount);
  const estimatedMix = scaleWindowMix(input.mix, estimatedCount);
  const catalog: WindowCatalog = input.catalog ?? (input.tiers === undefined ? DEFAULT_WINDOW_CATALOG : { ...DEFAULT_WINDOW_CATALOG, tiers: [...input.tiers] });
  const tiles = catalog.styleTiles;
  const baseTile = tiles[0]!;
  const dollars = (cents: number | null): number | null => (cents === null ? null : Math.round(cents / 100));
  const atVisitCount = input.measured.filter((w) => w.style !== undefined && tileOfStyle(tiles, w.style).atVisit).length;
  const out: HomeownerQuoteTier[] = catalog.tiers
    .filter((t) => t.enabled)
    .map((t) => {
      const perWindow = input.measured.map((w) => {
        const tile = w.style === undefined ? baseTile : tileOfStyle(tiles, w.style);
        const price = dollars(catalogWindowCents(catalog, tile, t.tier, w.sizeClass, w.frosted === true));
        return price === null ? { windowId: w.id, price: 0, atVisit: true } : { windowId: w.id, price };
      });
      const estimatedTotal = WINDOW_SIZE_CLASSES.reduce((n, c) => n + estimatedMix[c] * (dollars(catalogWindowCents(catalog, baseTile, t.tier, c, false)) ?? 0), 0);
      return {
        key: t.tier,
        label: t.label ?? TIER_LABELS[t.tier],
        note: t.note ?? '',
        name: t.name,
        description: t.description,
        total: perWindow.reduce((n, w) => n + w.price, 0) + estimatedTotal,
        perWindow,
        estimatedCount,
        estimatedTotal,
      };
    });
  const quote: HomeownerQuote = { tiers: out, measuredCount, estimatedCount, ...(atVisitCount > 0 && { atVisitCount }) };
  // "Did we miss any?": fewer measured than the address estimate's low end, when the homeowner has not said their own count.
  if (input.override === null && input.expected !== null && measuredCount > 0 && measuredCount < input.expected.low) {
    const { low, high, likely } = input.expected;
    const about = low === high ? `about ${likely}` : `about ${low} to ${high}`;
    quote.missingHint = {
      measured: measuredCount,
      expectedLow: low,
      expectedHigh: high,
      expectedLikely: likely,
      text: `We think your home has ${about} windows and you have measured ${measuredCount}. Did we miss any?`,
    };
  }
  return quote;
}
