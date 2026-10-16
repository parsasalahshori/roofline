// Measure windows: the shared contract between the API and the web app.
// Like the roof, the default needs no AI: the house's outline and Google's heights give its walls (length, height,
// floors), and the windows are worked out from the wall area ('estimated'). A street-level photo of the front lets a
// person mark each window; a marked window is sized from the photo's geometry ('measured', source 'marked'). An
// optional detector can find the front windows instead (source 'detector'); it is off by default.
// Estimated windows are never shown or priced as measured.
import type { Tier } from './proposals.ts';
import type { Quad } from './window-photo-math.ts';

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
  /**
   * The front wall from the outline and Google's heights, drawn into this photo: its four corners (bottom-left,
   * bottom-right, top-right, top-left; 0..1 of the photo) at ground and eave level. If it lines up with the house in the
   * photo, the camera, wall length and wall height are right. Absent when the wall is not in this photo.
   */
  wallOverlay?: {
    corners: [[number, number], [number, number], [number, number], [number, number]];
    /** How well the drawn wall lines up with the edges in the photo (no AI: image edges). 'unknown' when it cannot tell. */
    fit: 'good' | 'off' | 'unknown';
    /** 0..1 share of the drawn wall edges that sit on an edge in the photo. */
    fitScore: number | null;
    /** Heading correction the line-up found, degrees (Street View headings can be off by a few degrees). */
    headingCorrectionDeg: number;
    /** The wall height read from this photo (eave line), feet, to compare with the height from Google's heights. */
    wallHeightFromPhotoFt: number | null;
  };
};

/** A window marked by a person (or found by the optional detector) in a photo and sized from it. Box: 0..1 of the photo. */
export type MeasuredWindow = {
  id: string;
  photoId: string;
  /** 'marked' = a person drew it; 'detector' = the optional detector found it. Absent means 'detector' (older rows). */
  source?: 'marked' | 'detector';
  box: { x: number; y: number; w: number; h: number };
  widthIn: number;
  heightIn: number;
  sizeClass: WindowSizeClass;
  /** 1 = ground floor. */
  floor: number;
  /** The detector's confidence, 0..1. */
  confidence: number;
};

/** Windows worked out (not seen): counts per size class and how they were worked out. */
export type EstimatedWindows = {
  /** 'all-sides' when nothing on the front is measured; 'sides-and-back' once front windows are marked or found. */
  covers?: 'all-sides' | 'sides-and-back';
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
  'estimated-from-size', // no window was marked or found: every window is worked out from the house's walls
  'walls-unconfirmed', // the outline's front wall does not line up with the house in the street-level photo
] as const;
export type WindowsReviewReason = (typeof WINDOWS_REVIEW_REASONS)[number];

/** A box a person drew on a photo; the server sizes it into a MeasuredWindow with source 'marked' (same id). */
export type MarkedBox = { id: string; photoId: string; box: { x: number; y: number; w: number; h: number } };

/** Known-size things a person can tape to the glass (inches, width x height when held upright). */
export const WINDOW_PHOTO_REFERENCES = {
  letter: { widthIn: 8.5, heightIn: 11 },
  legal: { widthIn: 8.5, heightIn: 14 },
  a4: { widthIn: 8.27, heightIn: 11.69 },
} as const;
export type WindowPhotoReference = keyof typeof WINDOW_PHOTO_REFERENCES;

/** A photo a person took of one window on site (stored by the API, served at .../uploads/:uploadId). */
export type WindowPhotoUpload = { id: string; widthPx: number; heightPx: number; /** 35 mm-equivalent focal length from the photo, when it says. */ focal35mm: number | null; takenAt: string | null };

/** How a window photo is scaled: a reference of known size on the glass, or one side measured by hand. */
export type WindowPhotoScale =
  | { kind: 'reference'; reference: WindowPhotoReference; corners: Quad }
  | { kind: 'known-side'; side: 'width' | 'height'; inches: number }
  | {
      /**
       * The printable measuring sheet (window-photo-cv.ts calibrationSheetSvg), found automatically in the photo: many
       * matched points (photo pixels <-> inches on the sheet) give a least-squares homography instead of four clicks.
       */
      kind: 'sheet';
      paper: 'letter' | 'a4';
      imagePoints: [number, number][];
      sheetPointsIn: [number, number][];
      /**
       * How far the measured frame sits in front of (+) or behind (-) the sheet's plane, inches (the sheet is on the
       * glass; the frame being measured is usually 0.5-2 in proud of it). Corrected using the camera distance.
       */
      planeOffsetIn: number;
    };

/** What the person enters for one photographed window: corners in photo pixels (TL, TR, BR, BL). */
export type PhotoWindowInput = { id: string; uploadId: string; label?: string; corners: Quad; scale: WindowPhotoScale };

/** A photographed window sized by window-photo-math (server recomputes; the browser may preview with the same code). */
export type PhotoWindow = PhotoWindowInput & {
  widthIn: number;
  heightIn: number;
  sizeClass: WindowSizeClass;
  /** Expected error of widthIn / heightIn (inches, about 1 sigma), when the method can tell (sheet method). */
  uncertaintyIn?: { width: number; height: number } | null;
  /** Camera to the sheet's plane, inches, and the viewing angle off straight-on, degrees (sheet method). */
  distanceIn?: number | null;
  viewAngleDeg?: number | null;
  /** 'check' when the corners are nearly degenerate or the photo was steeply angled (> 50 deg). */
  quality: 'good' | 'check';
};

/** The person's changes: windows left out of the quote, and counts typed in per size class (replacing the estimate). */
export type WindowAdjustments = {
  excludedWindowIds: string[];
  /** Windows the person marked on the photos (absent = none). */
  marked?: MarkedBox[];
  /** Windows photographed on site (absent = none). Each counts as measured. */
  photoWindows?: PhotoWindowInput[];
  /** True once the person has photographed every window: the estimate then counts nothing (typed counts still do). */
  photosCoverAllWindows?: boolean;
  /** The person dragged the drawn wall's corners onto the house in a photo; the server re-fits camera and wall from it. */
  wallCorners?: { photoId: string; corners: [[number, number], [number, number], [number, number], [number, number]] } | null;
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
  /** The walls the estimate is worked out from (from the outline and Google's heights). Absent/null when unknown. */
  walls?: { perimeterFt: number; wallHeightFt: number | null; wallAreaSqFt: number | null; frontWallFt: number | null } | null;
  detector: WindowDetectorName | null;
  missing: { reason: WindowsMissReason } | null;
  needsReview: { reasons: WindowsReviewReason[] } | null;
  adjustments: WindowAdjustments;
  /** How long the server took to measure, ms (the scan shows "in N seconds"). */
  tookMs: number;
  /** Windows photographed on site, sized (absent = none). */
  photoWindows?: PhotoWindow[];
  /** Photos uploaded for this measurement (absent = none). */
  uploads?: WindowPhotoUpload[];
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

export function windowCounts(view: Pick<WindowMeasurementView, 'windows' | 'estimated' | 'adjustments'> & Pick<Partial<WindowMeasurementView>, 'photoWindows'>): WindowCounts {
  const out = Object.fromEntries(WINDOW_SIZE_CLASSES.map((c) => [c, { measured: 0, estimated: 0 }])) as WindowCounts;
  const excluded = new Set(view.adjustments.excludedWindowIds);
  for (const w of view.windows) if (!excluded.has(w.id)) out[w.sizeClass].measured += 1;
  for (const w of view.photoWindows ?? []) if (!excluded.has(w.id)) out[w.sizeClass].measured += 1;
  const allPhotographed = view.adjustments.photosCoverAllWindows === true;
  for (const c of WINDOW_SIZE_CLASSES) {
    const manual = view.adjustments.manualCounts[c];
    out[c].estimated = manual !== undefined ? Math.max(0, Math.round(manual)) : allPhotographed ? 0 : (view.estimated?.bySizeClass[c] ?? 0);
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
