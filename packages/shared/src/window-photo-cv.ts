// Exact window sizes from a phone photo: the contract of the measuring engine (implemented in this file by the
// engine work; the screen calls only these functions). Everything runs in the browser on the photo's pixels; the
// server re-checks the arithmetic from the points the browser sends (WindowPhotoScale kind 'sheet').
import type { Pt, Quad } from './window-photo-math.ts';

/** Pixels as the browser's canvas gives them (ImageData): RGBA, row-major. */
export type RgbaImage = { width: number; height: number; data: Uint8ClampedArray };

export type SheetPaper = 'letter' | 'a4';

/** The printable measuring sheet: markers at known positions plus a ruler to check the printer did not scale it. */
export type CalibrationSheet = { paper: SheetPaper; svg: string; widthIn: number; heightIn: number };

/** The sheet found in a photo: matched points and how well a single plane explains them. */
export type SheetDetection = {
  paper: SheetPaper;
  imagePoints: Pt[];
  sheetPointsIn: Pt[];
  /** RMS reprojection error of the fitted homography, pixels (well under 1 px when the sheet is flat and sharp). */
  rmsErrorPx: number;
  /** The sheet's outline in the photo (for drawing it). */
  outline: Quad;
  /**
   * How many sheets were found (1, or 2 for a big window: sheet A and sheet B, printed with different markers, taped in
   * opposite corners of the glass). With 2, `sheetIndex[i]` says which sheet point i is on (0 = A, 1 = B), and
   * `sheetPointsIn` are inches on that sheet. Absent means one sheet.
   */
  sheets?: number;
  sheetIndex?: number[];
};

/** Which boundary of the window a quad follows, from the outside in. */
export type WindowLayer = 'outer-trim' | 'frame-inner' | 'sash' | 'glass' | 'unknown';
/** What the person is measuring: inside the frame (the usual replacement size), outside the trim, or the glass. */
export type WindowMeasureTarget = 'inside-frame' | 'outside-trim' | 'glass';

/** A window corner quad refined onto the frame's edges, with how sure each side is (0..1). */
export type SnappedQuad = {
  quad: Quad;
  sideConfidence: [number, number, number, number];
  moved: boolean;
  /** One-sigma pixel noise of each corner from the edge fits (pass to measure as cornerSigmaPx). */
  cornerSigmaPx?: [number, number, number, number];
  /** Per side: how many other strong parallel edges (trim, sash, glass) were near; above 0 the person should check it. */
  rivals?: [number, number, number, number];
  /**
   * Whole-rectangle hypotheses (the same boundary on all four sides), ranked, the chosen one first. When the top two
   * scores are close the screen asks the person to pick an outline.
   */
  candidates?: { quad: Quad; layer: WindowLayer; score: number }[];
};

export type WindowPhotoMeasurement = {
  widthIn: number;
  heightIn: number;
  uncertaintyIn: { width: number; height: number };
  distanceIn: number;
  viewAngleDeg: number;
  /** Plain warnings for the person ("Step back: the photo is too close", "Stand more square to the window"). */
  warnings: string[];
};

export type WindowPhotoCv = {
  calibrationSheet(paper: SheetPaper): CalibrationSheet;
  /** Finds the measuring sheet; null when it is not in the photo or too blurred/small to trust. */
  detectSheet(img: RgbaImage): Promise<SheetDetection | null>;
  /**
   * Moves rough corners onto the frame's edges nearby (search band about 3% of the photo). With the sheet, the
   * rectangle hypotheses are checked for right angles on the glass's plane; with a target, that layer is preferred.
   */
  snapQuad(img: RgbaImage, rough: Quad, opts?: { sheet?: Pick<SheetDetection, 'imagePoints' | 'sheetPointsIn' | 'sheetIndex'>; target?: WindowMeasureTarget }): Promise<SnappedQuad>;
  /**
   * Proposes the window's rectangle around the found sheet (the sheet sits on the glass), so the person rarely drags
   * corners from scratch; null when nothing rectangular encloses the sheet. Same shape as snapQuad (candidates ranked).
   */
  proposeQuad?(img: RgbaImage, sheet: SheetDetection, target?: WindowMeasureTarget): Promise<SnappedQuad | null>;
  /** The window's size from the sheet, its corners, the camera focal length (pixels) and the frame's offset. */
  measure(input: {
    widthPx: number;
    heightPx: number;
    focalPx: number;
    sheet: Pick<SheetDetection, 'imagePoints' | 'sheetPointsIn' | 'sheetIndex'>;
    windowQuad: Quad;
    planeOffsetIn: number;
    /**
     * The printed scale the person read off the sheet's ruler (1 = 100%, 0.98 when the 6 in ruler measured 5.88 in).
     * The sheet's inches are multiplied by it. 1 when not given.
     */
    printScale?: number;
    /** From snapQuad (1.5 px when not given: corners placed by hand). */
    cornerSigmaPx?: number | [number, number, number, number];
  }): WindowPhotoMeasurement | null;
  /** Several photos of the same window combined: the median size and the spread between photos. */
  combine(ms: WindowPhotoMeasurement[]): { widthIn: number; heightIn: number; spreadIn: { width: number; height: number } } | null;
};
