// Measure windows: the shared contract between the API and the web app.
// A window measurement reads the front of the house from a street-level photo: each window the detector finds there is
// sized from the photo's geometry ('measured'); the sides and back cannot be seen from the street, so their windows are
// worked out from the house's size and floors ('estimated') and never shown or priced as measured.
import type { Tier } from './proposals.ts';

type LngLat = [number, number];

/** Window sizes by united inches (width + height), the way window replacement is priced. */
export const WINDOW_SIZE_CLASSES = ['small', 'standard', 'large', 'picture'] as const;
export type WindowSizeClass = (typeof WINDOW_SIZE_CLASSES)[number];

/** Upper united-inch bound of each class; anything above 'large' is 'picture'. */
export const WINDOW_CLASS_MAX_UI: Readonly<Record<Exclude<WindowSizeClass, 'picture'>, number>> = {
  small: 72,
  standard: 101,
  large: 120,
};

export function windowSizeClass(widthIn: number, heightIn: number): WindowSizeClass {
  const ui = widthIn + heightIn;
  if (ui <= WINDOW_CLASS_MAX_UI.small) return 'small';
  if (ui <= WINDOW_CLASS_MAX_UI.standard) return 'standard';
  if (ui <= WINDOW_CLASS_MAX_UI.large) return 'large';
  return 'picture';
}

/** Who found the windows. 'stand-in' is the demo detector: its windows are made up and a quote from them says so. */
export const WINDOW_DETECTORS = ['claude', 'owlv2', 'stand-in'] as const;
export type WindowDetectorName = (typeof WINDOW_DETECTORS)[number];

/** One street-level photo of the front of the house, served by GET /api/window-measurements/:id/photos/:photoId. */
export type FacadePhoto = {
  id: string;
  /** Compass heading the camera looks along, degrees from north. */
  heading: number;
  /** Horizontal field of view, degrees. */
  fov: number;
  widthPx: number;
  heightPx: number;
  /** When the street-level imagery was captured, 'YYYY-MM' (null if the provider does not say). */
  capturedOn: string | null;
  /** Camera to the front wall along the photo's centre line, metres. */
  distanceM: number;
};

/** A window found in a photo and sized from it. The box is in 0..1 of the photo's width and height. */
export type MeasuredWindow = {
  id: string;
  photoId: string;
  box: { x: number; y: number; w: number; h: number };
  widthIn: number;
  heightIn: number;
  sizeClass: WindowSizeClass;
  /** 1 = ground floor. */
  floor: number;
  /** The detector's confidence, 0..1. */
  confidence: number;
};

/** Windows on the sides and back, worked out (not seen): counts per size class and how they were worked out. */
export type EstimatedWindows = {
  bySizeClass: Record<WindowSizeClass, number>;
  /** Plain-English basis, shown to the user, e.g. "2 floors, 186 ft of side and back wall, front spacing". */
  basis: string;
};

/** Why no windows could be measured. The view still carries an estimate when the house's size is known. */
export const WINDOWS_MISS_REASONS = [
  'no-street-view', // no street-level imagery near the house
  'house-blurred', // the owner had the house blurred in the imagery
  'facade-hidden', // trees, fences or vehicles hide the front
  'no-footprint', // no building outline to aim the camera at
  'detector-unconfigured', // no window detector set up (no key, no model)
  'detector-error', // the detector failed or timed out
] as const;
export type WindowsMissReason = (typeof WINDOWS_MISS_REASONS)[number];

/** Why a person should check the result before it is priced. */
export const WINDOWS_REVIEW_REASONS = [
  'stand-in-detector', // the demo detector made these windows up
  'front-only', // only the front was seen; the rest is estimated
  'low-confidence', // some windows were found with low confidence
  'old-imagery', // the street-level photo is more than 5 years old
  'partly-hidden', // part of the front is hidden
] as const;
export type WindowsReviewReason = (typeof WINDOWS_REVIEW_REASONS)[number];

/** The person's changes: windows left out of the quote, and counts typed in per size class (replacing the estimate). */
export type WindowAdjustments = {
  excludedWindowIds: string[];
  /** Added to the measured windows, per size class (replaces `estimated` for that class when set). */
  manualCounts: Partial<Record<WindowSizeClass, number>>;
};

/** GET/POST /api/window-measurements(/:id). */
export type WindowMeasurementView = {
  id: string;
  propertyId: string;
  address: string;
  center: LngLat;
  createdAt: string;
  photos: FacadePhoto[];
  windows: MeasuredWindow[];
  estimated: EstimatedWindows | null;
  /** Floors above ground, when known (from the house's height). */
  stories: number | null;
  detector: WindowDetectorName | null;
  missing: { reason: WindowsMissReason } | null;
  needsReview: { reasons: WindowsReviewReason[] } | null;
  adjustments: WindowAdjustments;
  /** How long the server took to measure, ms (the scan shows "in N seconds"). */
  tookMs: number;
};

/** PATCH /api/window-measurements/:id. */
export type WindowMeasurementPatch = Partial<WindowAdjustments>;

/** Installed price per window, per size class, for one tier. Cents. */
export type WindowTier = {
  tier: Tier;
  name: string;
  description: string;
  priceCents: Record<WindowSizeClass, number>;
  enabled: boolean;
};

export const DEFAULT_WINDOW_TIERS: readonly WindowTier[] = [
  {
    tier: 'good',
    name: 'Vinyl double-hung',
    description: 'Double-pane, Low-E glass, standard install',
    priceCents: { small: 45_000, standard: 60_000, large: 75_000, picture: 95_000 },
    enabled: true,
  },
  {
    tier: 'better',
    name: 'Premium vinyl',
    description: 'Argon-filled Low-E, full-frame install, lifetime warranty',
    priceCents: { small: 62_000, standard: 80_000, large: 98_000, picture: 125_000 },
    enabled: true,
  },
  {
    tier: 'best',
    name: 'Fiberglass',
    description: 'Triple-pane, fiberglass frame, full-frame install',
    priceCents: { small: 95_000, standard: 120_000, large: 145_000, picture: 185_000 },
    enabled: true,
  },
];

/** Windows counted for the quote, per size class and per source. */
export type WindowCounts = Record<WindowSizeClass, { measured: number; estimated: number }>;

export function windowCounts(view: Pick<WindowMeasurementView, 'windows' | 'estimated' | 'adjustments'>): WindowCounts {
  const out = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, { measured: 0, estimated: 0 }])) as WindowCounts;
  const excluded = new Set(view.adjustments.excludedWindowIds);
  for (const w of view.windows) if (!excluded.has(w.id)) out[w.sizeClass].measured += 1;
  for (const c of WINDOW_SIZE_CLASSES) {
    const manual = view.adjustments.manualCounts[c];
    out[c].estimated = manual !== undefined ? Math.max(0, Math.round(manual)) : (view.estimated?.bySizeClass[c] ?? 0);
  }
  return out;
}

export type WindowQuoteLine = { sizeClass: WindowSizeClass; count: number; unitCents: number; amountCents: number };
export type WindowQuote = { tier: Tier; name: string; description: string; lines: WindowQuoteLine[]; windows: number; totalCents: number };

/** One quote per enabled tier: every counted window (measured and estimated) at that tier's installed price. */
export function priceWindows(counts: WindowCounts, tiers: readonly WindowTier[] = DEFAULT_WINDOW_TIERS): WindowQuote[] {
  return tiers
    .filter((t) => t.enabled)
    .map((t) => {
      const lines = WINDOW_SIZE_CLASSES.map((c) => {
        const count = counts[c].measured + counts[c].estimated;
        return { sizeClass: c, count, unitCents: t.priceCents[c], amountCents: count * t.priceCents[c] };
      }).filter((l) => l.count > 0);
      return {
        tier: t.tier,
        name: t.name,
        description: t.description,
        lines,
        windows: lines.reduce((n, l) => n + l.count, 0),
        totalCents: lines.reduce((n, l) => n + l.amountCents, 0),
      };
    });
}
