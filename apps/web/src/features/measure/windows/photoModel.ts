import {
  DEFAULT_FOCAL_35MM,
  focalPxFrom35mm,
  sizeFromArPoints,
  sizeFromKnownSide,
  sizeFromReference,
  WINDOW_PHOTO_REFERENCES,
  windowSizeClass,
  type PhotoWindow,
  type PhotoWindowInput,
  type Quad,
  type SheetDetection,
  type SnappedQuad,
  type WindowLayer,
  type WindowMeasureTarget,
  type WindowPhotoCv,
  type WindowPhotoMeasurement,
  type WindowPhotoUpload,
} from '@roofline/shared';

/** The window's corners to start from: the photo inset 15% on every side (TL, TR, BR, BL, photo pixels). */
export function seedWindowQuad(w: number, h: number): Quad {
  const x0 = w * 0.15;
  const x1 = w * 0.85;
  const y0 = h * 0.15;
  const y1 = h * 0.85;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** The paper's corners to start from: a small upright sheet in the middle of the photo, in the paper's proportions. */
export function seedPaperQuad(w: number, h: number, aspect = 8.5 / 11): Quad {
  const ph = Math.min(h * 0.18, (w * 0.18) / aspect);
  const pw = ph * aspect;
  const cx = w / 2;
  const cy = h / 2;
  return [
    [cx - pw / 2, cy - ph / 2],
    [cx + pw / 2, cy - ph / 2],
    [cx + pw / 2, cy + ph / 2],
    [cx - pw / 2, cy + ph / 2],
  ];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * The window's size worked out here, with the same math the server uses: from the paper on the glass, or from its own
 * corners and the side measured by hand. Null when the corners (or the typed side) cannot give a size.
 */
export function sizePhotoWindow(input: Pick<PhotoWindowInput, 'corners' | 'scale'>, upload: Pick<WindowPhotoUpload, 'widthPx' | 'heightPx' | 'focal35mm'>): { widthIn: number; heightIn: number } | null {
  const s = input.scale;
  let size: { widthIn: number; heightIn: number } | null;
  if (s.kind === 'reference') {
    const ref = WINDOW_PHOTO_REFERENCES[s.reference];
    size = sizeFromReference(input.corners, s.corners, ref.widthIn, ref.heightIn);
  } else if (s.kind === 'known-side') {
    if (!(s.inches > 0)) return null;
    const focalPx = focalPxFrom35mm(upload.focal35mm ?? DEFAULT_FOCAL_35MM, upload.widthPx, upload.heightPx);
    size = sizeFromKnownSide(input.corners, upload.widthPx, upload.heightPx, s.side, s.inches, focalPx);
  } else if (s.kind === 'ar') {
    // AR: the distance between the tapped 3D points (the photo only carries the thumbnail); 0.01 in like the server.
    const m = sizeFromArPoints(s.pointsM);
    if (m === null) return null;
    return { widthIn: Math.round(m.widthIn * 100) / 100, heightIn: Math.round(m.heightIn * 100) / 100 };
  } else {
    // The measuring sheet needs the engine (many points, the frame's offset): sized on the measure screen
    // (LocalSheetSize) and re-checked by the server.
    return null;
  }
  if (size === null || !Number.isFinite(size.widthIn) || !Number.isFinite(size.heightIn) || size.widthIn <= 0 || size.heightIn <= 0) return null;
  return { widthIn: round1(size.widthIn), heightIn: round1(size.heightIn) };
}

/**
 * The photographed windows as the screen shows them: the server's sized window when it has the same corners and
 * scale as on screen (its value wins), else the size worked out here. A window that cannot be sized yet is left out.
 */
export function livePhotoWindows(
  inputs: readonly PhotoWindowInput[],
  server: readonly PhotoWindow[] | undefined,
  uploads: readonly WindowPhotoUpload[],
  local: ReadonlyMap<string, LocalSheetSize> = new Map(),
): (PhotoWindow & { fromServer: boolean })[] {
  const byId = new Map((server ?? []).map((w) => [w.id, w]));
  return inputs.flatMap((input) => {
    const saved = byId.get(input.id);
    if (saved !== undefined && JSON.stringify([saved.corners, saved.scale]) === JSON.stringify([input.corners, input.scale])) {
      return [{ ...saved, label: input.label ?? saved.label, fromServer: true }] as (PhotoWindow & { fromServer: boolean })[];
    }
    const mine = local.get(input.id);
    if (mine !== undefined && mine.key === sizingKey(input)) {
      const m = { widthIn: mine.widthIn, heightIn: mine.heightIn, uncertaintyIn: mine.uncertaintyIn, distanceIn: mine.distanceIn, viewAngleDeg: mine.viewAngleDeg };
      return [{ ...input, ...m, sizeClass: windowSizeClass(m.widthIn, m.heightIn), quality: 'good' as const, fromServer: false }];
    }
    const upload = uploads.find((u) => u.id === input.uploadId);
    if (upload === undefined) return [];
    const size = sizePhotoWindow(input, upload);
    if (size === null) return [];
    return [{ ...input, ...size, sizeClass: windowSizeClass(size.widthIn, size.heightIn), quality: 'good' as const, fromServer: false }];
  });
}

/** What a window's size depends on: its corners and its scale. Same key, same size. */
export function sizingKey(input: Pick<PhotoWindowInput, 'corners' | 'scale'>): string {
  return JSON.stringify([input.corners, input.scale]);
}

/** A sheet-measured window sized on the measure screen (the engine's numbers), kept until the server's size arrives. */
export type LocalSheetSize = {
  key: string;
  widthIn: number;
  heightIn: number;
  uncertaintyIn: { width: number; height: number } | null;
  distanceIn: number | null;
  viewAngleDeg: number | null;
};

/** What the person is measuring, and how far it sits in front of the glass (where the sheet is), inches. */
export const PLANE_TARGETS = { frame: 1.0, trim: 1.5, glass: 0 } as const;
export type PlaneTarget = keyof typeof PLANE_TARGETS | 'custom';

/** The engine's name for what is measured, and the outline layer that is. ('custom' measures the frame.) */
export const ENGINE_TARGET = { frame: 'inside-frame', trim: 'outside-trim', glass: 'glass', custom: 'inside-frame' } as const satisfies Record<PlaneTarget, WindowMeasureTarget>;
export const TARGET_LAYER = { 'inside-frame': 'frame-inner', 'outside-trim': 'outer-trim', glass: 'glass' } as const satisfies Record<WindowMeasureTarget, WindowLayer>;

export function planeTargetFor(offsetIn: number): PlaneTarget {
  const hit = (Object.keys(PLANE_TARGETS) as (keyof typeof PLANE_TARGETS)[]).find((k) => PLANE_TARGETS[k] === offsetIn);
  return hit ?? 'custom';
}

/** Above this (either side, inches) the photo should be taken again. */
export const RETAKE_UNCERTAINTY_IN = 0.25;
/** A side the engine is less sure of than this gets "check this edge". */
export const LOW_SIDE_CONFIDENCE = 0.5;

/** The window's size from the sheet the engine found, with the camera's focal length from the photo. */
export function measureOnSheet(
  cv: Pick<WindowPhotoCv, 'measure'>,
  upload: Pick<WindowPhotoUpload, 'widthPx' | 'heightPx' | 'focal35mm'>,
  sheet: Pick<SheetDetection, 'imagePoints' | 'sheetPointsIn' | 'sheetIndex'>,
  windowQuad: Quad,
  planeOffsetIn: number,
  extra: {
    /** From snapQuad; absent for corners placed by hand (the engine then assumes 1.5 px). */
    cornerSigmaPx?: [number, number, number, number] | undefined;
    /** The printed sheet's scale read off its ruler (1 = 100%). */
    printScale?: number | undefined;
  } = {},
): WindowPhotoMeasurement | null {
  const focalPx = focalPxFrom35mm(upload.focal35mm ?? DEFAULT_FOCAL_35MM, upload.widthPx, upload.heightPx);
  const m = cv.measure({
    widthPx: upload.widthPx,
    heightPx: upload.heightPx,
    focalPx,
    sheet,
    windowQuad,
    planeOffsetIn,
    ...(extra.cornerSigmaPx !== undefined && { cornerSigmaPx: extra.cornerSigmaPx }),
    ...(extra.printScale !== undefined && extra.printScale !== 1 && { printScale: extra.printScale }),
  });
  if (m === null || !(m.widthIn > 0) || !(m.heightIn > 0) || !Number.isFinite(m.widthIn) || !Number.isFinite(m.heightIn)) return null;
  return m;
}

/** A sized photo as the engine's measurement (to combine several photos of one window). */
export function asMeasurement(w: Pick<PhotoWindow, 'widthIn' | 'heightIn' | 'uncertaintyIn' | 'distanceIn' | 'viewAngleDeg'>): WindowPhotoMeasurement {
  return {
    widthIn: w.widthIn,
    heightIn: w.heightIn,
    uncertaintyIn: w.uncertaintyIn ?? { width: 0, height: 0 },
    distanceIn: w.distanceIn ?? 0,
    viewAngleDeg: w.viewAngleDeg ?? 0,
    warnings: [],
  };
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Inches as a whole number and a reduced fraction, to the nearest 1/`den` (35.87 -> "35 7/8"; 36 -> "36"). */
export function inchesFraction(v: number, den = 8): string {
  const sign = v < 0 ? '-' : '';
  const total = Math.round(Math.abs(v) * den);
  const whole = Math.floor(total / den);
  const num = total % den;
  if (num === 0) return `${sign}${whole}`;
  const g = gcd(num, den);
  const frac = `${num / g}/${den / g}`;
  return whole === 0 ? `${sign}${frac}` : `${sign}${whole} ${frac}`;
}

/** An uncertainty rounded up to the next 1/16 in (never shown as less than 1/16): "1/16", "3/16", "1 1/4". */
export function plusMinusFraction(u: number): string {
  const sixteenths = Math.max(1, Math.ceil(Math.abs(u) * 16 - 1e-9));
  return inchesFraction(sixteenths / 16, 16);
}

/** Feet to one decimal, from inches (for "6.5 ft"). */
export const feet1 = (inches: number) => Math.round((inches / 12) * 10) / 10;

/**
 * The ruler printed on each measuring sheet (cv/sheet-layout.ts rulerSpec): 6 in on letter, 15 cm on A4. The person
 * measures it after printing; what they got over this is the printer's scale.
 */
export const SHEET_RULER = { letter: { length: 6, unit: 'in' }, a4: { length: 15, unit: 'cm' } } as const;
/** A printer scale outside this is a misprint, not a scale to correct for (print again at Actual size). */
export const PRINT_SCALE_RANGE = [0.9, 1.1] as const;

const PRINT_SCALE_KEY = (paper: string) => `roofline.measuringSheet.printScale.${paper}`;
/** This device's printed sheet's scale (1 = printed at exactly 100%). 1 when not checked or storage is blocked. */
export function readPrintScale(paper: string): number {
  try {
    const v = Number.parseFloat(globalThis.localStorage?.getItem(PRINT_SCALE_KEY(paper)) ?? '');
    return Number.isFinite(v) && v >= PRINT_SCALE_RANGE[0] && v <= PRINT_SCALE_RANGE[1] ? v : 1;
  } catch {
    return 1;
  }
}
export function writePrintScale(paper: string, scale: number): void {
  try {
    globalThis.localStorage?.setItem(PRINT_SCALE_KEY(paper), String(scale));
  } catch {
    // Private mode: the check holds for this visit only.
  }
}

/** Outlines close enough in score that the person picks (the engine ranks them; this is how close is "close"). */
export const CLOSE_SCORE = 0.15;

/** Whether to ask "Which outline are you measuring?": rival edges near a side, or the top two outlines score close. */
export function needsOutlinePick(s: Pick<SnappedQuad, 'rivals' | 'candidates'>): boolean {
  const c = s.candidates ?? [];
  if (c.length < 2) return false;
  if ((s.rivals ?? []).some((r) => r > 0)) return true;
  const [a, b] = [c[0]!.score, c[1]!.score];
  return Math.abs(a - b) <= CLOSE_SCORE * Math.max(Math.abs(a), Math.abs(b), 1e-9);
}
