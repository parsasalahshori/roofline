import type { QuoteProduct } from './instant-quote.ts';
import type { LngLat } from './roof.ts';
import type { WindowStyle } from './window-order.ts';
import type { ArDevice, ArQuad, Quad } from './window-photo-math.ts';
import type { RoomPlanConfidence, WindowSizeClass } from './windows.ts';

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
 * now (the company's daily limit, or the address lookup was down).
 */
export const HOMEOWNER_CALLBACK_REASONS = ['unit', 'address', 'home', 'busy'] as const;
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

export type HomeownerWindowStyleOption = { key: WindowStyle; label: string };

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
  /** Reserved: always null until a company can enter reviews, the year it started and its licence number. */
  trust: { reviews?: number; since?: number; license?: string } | null;
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
  /** 'at-visit': gutters are priced at the free visit, never online. */
  gutters: 'at-visit' | null;
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
};

export type HomeownerQuoteTier = {
  key: HomeownerTierKey;
  /** "Good", "Better", "Best". */
  label: string;
  /** What the tier is ("Vinyl double-hung") and a line about it. */
  name: string;
  description: string;
  /** Whole dollars, installed: every measured window plus the estimated ones. total = sum(perWindow) + estimatedTotal. */
  total: number;
  perWindow: { windowId: string; price: number }[];
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
