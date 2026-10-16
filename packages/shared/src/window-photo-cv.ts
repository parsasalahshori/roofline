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
};

/** A window corner quad refined onto the frame's edges, with how sure each side is (0..1). */
export type SnappedQuad = { quad: Quad; sideConfidence: [number, number, number, number]; moved: boolean };

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
  /** Moves rough corners onto the frame's edges nearby (search band about 3% of the photo). */
  snapQuad(img: RgbaImage, rough: Quad): Promise<SnappedQuad>;
  /** The window's size from the sheet, its corners, the camera focal length (pixels) and the frame's offset. */
  measure(input: { widthPx: number; heightPx: number; focalPx: number; sheet: Pick<SheetDetection, 'imagePoints' | 'sheetPointsIn'>; windowQuad: Quad; planeOffsetIn: number }): WindowPhotoMeasurement | null;
  /** Several photos of the same window combined: the median size and the spread between photos. */
  combine(ms: WindowPhotoMeasurement[]): { widthIn: number; heightIn: number; spreadIn: { width: number; height: number } } | null;
};
