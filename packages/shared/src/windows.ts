// Measure windows: the shared contract between the API and the web app.
// Like the roof, the default needs no AI: the house's outline and Google's heights give its walls (length, height,
// floors), and the windows are worked out from the wall area ('estimated'). A street-level photo of the front lets a
// person mark each window; a marked window is sized from the photo's geometry ('measured', source 'marked'). An
// optional detector can find the front windows instead (source 'detector'); it is off by default.
// Estimated windows are never shown or priced as measured.
import type { Tier } from './proposals.ts';
import type { WindowStyle } from './window-order.ts';
import type { ArDevice, ArQuad, Quad } from './window-photo-math.ts';

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
   * The photo is past the days Google's terms let it be kept and is deleted (or about to be): the photo area says so
   * instead of loading it. Its numbers (heading, line-up, the windows marked on it) are kept. Absent or false otherwise.
   */
  expired?: boolean;
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
    /**
     * Pitch and roll corrections the line-up found, degrees (Street View's camera pitch reference sits a few degrees
     * off; a car on a cambered road rolls). Absent on older rows and when the line-up is not good: 0.
     */
    pitchCorrectionDeg?: number;
    rollCorrectionDeg?: number;
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
  /** The size before a door ruler on its photo corrected it (absent: no ruler on its photo). */
  beforeRuler?: { widthIn: number; heightIn: number };
};

/** Windows worked out (not seen): counts per size class and how they were worked out. */
export type EstimatedWindows = {
  /** 'all-sides' when nothing on the front is measured; 'sides-and-back' once front windows are marked or found. */
  covers?: 'all-sides' | 'sides-and-back';
  bySizeClass: Record<WindowSizeClass, number>;
  /**
   * How far off the count may be, when an input is shaky (no height data, a storey and a half, a low wing that may be a
   * garage or a room, an outline from Google's roof): the count is shown as "low to high". Absent/null: no range.
   */
  range?: { low: number; high: number } | null;
  /** Plain-English basis (API consumers; the web app words it from the walls itself). */
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

/**
 * A door marked as a ruler on a Street View photo: a thing of known size on the front, so the photo's scale can be
 * checked. A garage door is nearly always flush with its wall, so it is the better ruler; a front door often sits back
 * in a porch or an entry, which makes it look smaller and the windows come out too big.
 */
export const RULER_KINDS = ['garage-door', 'front-door', 'custom'] as const;
export type RulerKind = (typeof RULER_KINDS)[number];

/** Standard door sizes, inches (width x height), first one the default. Garage doors: 16 x 7 ft, 9 x 7, 18 x 7, 16 x 8. */
export const RULER_SIZES: Readonly<Record<Exclude<RulerKind, 'custom'>, readonly { widthIn: number; heightIn: number }[]>> = {
  'garage-door': [
    { widthIn: 192, heightIn: 84 },
    { widthIn: 108, heightIn: 84 },
    { widthIn: 216, heightIn: 84 },
    { widthIn: 192, heightIn: 96 },
  ],
  'front-door': [
    { widthIn: 36, heightIn: 80 },
    { widthIn: 32, heightIn: 80 },
    { widthIn: 72, heightIn: 80 },
  ],
};
/** A custom ruler's sides, inches. */
export const RULER_MIN_IN = 12;
export const RULER_MAX_IN = 300;

/** The door a person marked as a ruler (box: 0..1 of the photo) and its real size. */
export type DoorRuler = { photoId: string; box: { x: number; y: number; w: number; h: number }; kind: RulerKind; widthIn: number; heightIn: number };

/**
 * What the server made of the ruler. Assumption: the door is flush with the wall the windows are on, and what is off
 * is the camera's distance to the house (Street View's position or the outline can be metres off); so the camera is
 * moved along its line to the wall until the door comes out at its real size, and every marked window on that photo
 * is sized again with it. `rangeM`: camera to the door, as drawn from the outline and as the ruler puts it.
 */
export type RulerResult = {
  photoId: string;
  kind: RulerKind;
  widthIn: number;
  heightIn: number;
  /** The door as sized from the outline's wall, before the correction. */
  measuredWidthIn: number;
  measuredHeightIn: number;
  /** Real over measured size (geometric mean of width and height): 1.3 = things were coming out 30% small. */
  scale: number;
  rangeM: { before: number; after: number };
  /** 'check' when the door's width and height disagree on the scale by more than 15% (box not on the door's edges). */
  agreement: 'good' | 'check';
};

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
      /** Two sheets (big windows): which sheet each point is on, 0 = A, 1 = B. Absent: one sheet. */
      sheetIndex?: number[];
      /** The printed scale read off the sheet's ruler (1 = 100%). Absent: 1. */
      printScale?: number;
    }
  | {
      /**
       * AR on a phone (Android WebXR hit-test, or the iPhone app's ARKit): the person tapped the window FRAME's four
       * corners. No scale prop: the size is the distance between the points (window-photo-math sizeFromArPoints). The
       * PhotoWindowInput's corners are the same four points drawn into the one photo kept with it (or that photo inset
       * 15% when they could not be).
       */
      kind: 'ar';
      /** The frame's four corners, metres, AR world space (+Y up). Meant as TL, TR, BR, BL, but ordered by gravity on use. */
      pointsM: ArQuad;
      /** How many times AR lost the wall while the corners were being tapped. */
      trackingLostCount: number;
      /** Which AR measured them; sets the per-point noise in the ±. Absent: 'webxr' (the Android web app). */
      device?: ArDevice;
      /** Each corner's measured spread, metres, 1 sigma, in the order of pointsM (the iPhone averages ~15 raycasts). */
      cornerSpreadM?: [number, number, number, number];
    }
  | {
      /**
       * Apple RoomPlan on a LiDAR iPhone: the room scan found the window and gives its size directly. Quote-grade only:
       * always 'check', at least ROOMPLAN_MIN_UNCERTAINTY_IN of ±, and never order-grade (the order sheet refuses a
       * window measured only this way). The PhotoWindowInput may have no photo (no uploadId, no corners).
       */
      kind: 'roomplan';
      widthM: number;
      heightM: number;
      /** RoomPlan's own confidence in the surface. */
      confidence: RoomPlanConfidence;
    }
  | {
      /**
       * A credit card (ISO/IEC 7810 ID-1, 85.60 x 53.98 mm) held or taped flat on the glass: the person taps its four
       * corners and the window frame's four corners on one photo, and the size comes from the homography of the card's
       * known size (window-photo-card.ts). Quote-grade (the card is small next to the window): its ± grows with the
       * window-to-card size ratio and the window is 'check' above CARD_CHECK_UNCERTAINTY_IN. The PhotoWindowInput's
       * `corners` are the window frame's corners in the same photo; `uploadId` and `corners` are required.
       */
      kind: 'card';
      /**
       * The card's four corners in the photo (pixels), each tapped at the tip of the card's rounded corner, in order
       * around the card (clockwise or counterclockwise, starting at any corner: the server finds which side is long).
       */
      cardCorners: Quad;
      /** The card's size, millimetres: always the ID-1 size (the server refuses any other). */
      card: { widthMm: number; heightMm: number };
    };

export const ROOMPLAN_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type RoomPlanConfidence = (typeof ROOMPLAN_CONFIDENCES)[number];
/** The least ± a RoomPlan size carries, inches (RoomPlan is a quote-grade scan, not a frame-corner measure). */
export const ROOMPLAN_MIN_UNCERTAINTY_IN = 1;
/** RoomPlan's ± by its confidence, inches (UNCALIBRATED until the field test; never under the 1 in floor). */
export const ROOMPLAN_UNCERTAINTY_IN: Readonly<Record<RoomPlanConfidence, number>> = { high: 1, medium: 1.5, low: 2 };

/** PhotoWindowInput.source for a window the homeowner measured in the phone app. */
export const HOMEOWNER_APP_SOURCE = 'homeowner-app' as const;

/**
 * What the person enters for one photographed window: corners in photo pixels (TL, TR, BR, BL). Several photos of the
 * same window share a `windowKey` (one PhotoWindowInput per photo); absent means the photo is its own window.
 * `uploadId` and `corners` are always there except for a RoomPlan window (scale kind 'roomplan'), which may have no
 * photo; the API refuses them missing for any other kind.
 */
export type PhotoWindowInput = {
  id: string;
  uploadId?: string;
  label?: string;
  windowKey?: string;
  corners?: Quad;
  scale: WindowPhotoScale;
  /**
   * Where the window was measured from, when not by staff: 'homeowner-app' = the homeowner measured it themselves in the
   * phone app (public homeowner API). Quote-grade only: never used for a factory order, whatever its scale. Set by the
   * server; staff cannot set it (a staff edit that changes the measurement takes it off).
   */
  source?: typeof HOMEOWNER_APP_SOURCE;
  /** The room the homeowner put the window in ("Kitchen", "Bedroom 1"), when they said. */
  room?: string;
  /** The window's style as the homeowner picked it. */
  style?: WindowStyle;
  /** Bathroom window: frosted (privacy) glass, which adds to the price. Absent: clear glass. */
  frosted?: boolean;
};

/** The window a photographed window belongs to: its shared key, else its own id (one photo, one window). */
export function photoWindowKey(w: Pick<PhotoWindowInput, 'id' | 'windowKey'>): string {
  return w.windowKey !== undefined && w.windowKey !== '' ? w.windowKey : w.id;
}

const median = (vs: number[]): number => {
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Photographed windows grouped into windows: each group's photos (in order) and its size class from the median width
 * and height of its photos. Excluded photos are left out; a group with every photo excluded is gone.
 */
export function photoWindowGroups<T extends Pick<PhotoWindow, 'id' | 'windowKey' | 'widthIn' | 'heightIn'>>(ws: readonly T[], excluded: ReadonlySet<string> = new Set()): { key: string; photos: T[]; sizeClass: WindowSizeClass }[] {
  const groups = new Map<string, T[]>();
  for (const w of ws) {
    if (excluded.has(w.id)) continue;
    const k = photoWindowKey(w);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  return [...groups].map(([key, photos]) => ({ key, photos, sizeClass: windowSizeClass(median(photos.map((p) => p.widthIn)), median(photos.map((p) => p.heightIn))) }));
}

/** A photographed window sized by window-photo-math (server recomputes; the browser may preview with the same code). */
export type PhotoWindow = PhotoWindowInput & {
  widthIn: number;
  heightIn: number;
  sizeClass: WindowSizeClass;
  /** Expected error of widthIn / heightIn (inches, about 1 sigma), when the method can tell (sheet and AR methods). */
  uncertaintyIn?: { width: number; height: number } | null;
  /** Camera to the sheet's plane, inches, and the viewing angle off straight-on, degrees (sheet method). */
  distanceIn?: number | null;
  viewAngleDeg?: number | null;
  /** 'check' when the corners are nearly degenerate or the photo was steeply angled (> 50 deg); AR: not a flat rectangle. */
  quality: 'good' | 'check';
  /** Why 'check', in plain words (the card method's; absent for the others). */
  reasons?: string[];
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
  /** A door marked as a ruler on a photo: every marked window on that photo is sized again to fit it (null/absent: none). */
  ruler?: DoorRuler | null;
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
  /** Floors above ground, when known (from the house's height): 1, 1.5 (a storey and a half), 2 or 3. */
  stories: number | null;
  /** The walls the estimate is worked out from (from the outline and Google's heights). Absent/null when unknown. */
  walls?: {
    perimeterFt: number;
    wallHeightFt: number | null;
    wallAreaSqFt: number | null;
    frontWallFt: number | null;
    /** The wall the windows are counted on: 9 ft a floor, low wings left out (absent on older answers). */
    windowWallSqFt?: number;
    /** Low one-storey wings of a taller house (an attached garage, a porch) left out of the count, feet of wall. */
    lowWingFt?: number;
    /** Where the floors come from: Google's height map, a person's fit on the street photo, or assumed (one floor) when there is none. */
    floorsFrom?: 'height-map' | 'photo' | 'assumed';
    /** Where the outline comes from: a building footprint, else Google's roof (no footprint there). */
    outlineFrom?: 'footprint' | 'google-roof';
  } | null;
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
  /** The door ruler, as the server applied it (absent/null: none, or it could not be sized). */
  ruler?: RulerResult | null;
  /**
   * The Street View tools are on for this server (WINDOWS_STREET_VIEW_TOOLS): the front wall drawn on the photo, its
   * corners, marking windows on the photo and the door ruler. Absent or false: the photo is a read-only picture.
   */
  photoTools?: boolean;
};

/** PATCH /api/window-measurements/:id. */
export type WindowMeasurementPatch = Partial<WindowAdjustments>;

/** Installed price per window, per size class, for one tier. Cents. */
export type WindowTier = {
  tier: Tier;
  name: string;
  description: string;
  /** The company's own name for the tier ("Replenish"); absent: Good, Better or Best. */
  label?: string;
  /** One line for the tier's card ("Lifetime warranty"); absent: none. */
  note?: string;
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
  // Several photos of one window (a shared windowKey) count as one window
  for (const g of photoWindowGroups(view.photoWindows ?? [], excluded)) out[g.sizeClass].measured += 1;
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
