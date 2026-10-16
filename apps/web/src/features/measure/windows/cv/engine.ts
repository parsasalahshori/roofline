// The measuring engine (WindowPhotoCv, packages/shared/src/window-photo-cv.ts). Loaded lazily by index.ts: the screen
// calls loadWindowPhotoCv() on the photo-measure view only, so the rest of the app never downloads it.
import { combineSheetMeasurements, measureWithSheet, type RgbaImage, type WindowPhotoCv } from '@roofline/shared';
import { detectSheetSync } from './detect-sheet.ts';
import { calibrationSheetSvg } from './sheet-layout.ts';
import { proposeQuadSync } from './propose-quad.ts';
import { snapQuadSync } from './snap-quad.ts';

/** Gives the browser a frame between heavy steps so a spinner keeps turning. */
const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const windowPhotoCv: WindowPhotoCv = {
  calibrationSheet: (paper, which) => calibrationSheetSvg(paper, which === 'B' ? 1 : 0),
  async detectSheet(img: RgbaImage) {
    await yieldToBrowser();
    return detectSheetSync(img);
  },
  async snapQuad(img, rough, opts) {
    await yieldToBrowser();
    return snapQuadSync(img, rough, { sheet: opts?.sheet, target: opts?.target });
  },
  async proposeQuad(img, sheet, target) {
    await yieldToBrowser();
    return proposeQuadSync(img, sheet, target);
  },
  measure(input) {
    const m = measureWithSheet({ ...input, printScale: input.printScale, focalSigmaFrac: input.focalSigmaFrac, imagePoints: input.sheet.imagePoints, sheetPointsIn: input.sheet.sheetPointsIn, sheetIndex: input.sheet.sheetIndex });
    if (m === null) return null;
    return { widthIn: m.widthIn, heightIn: m.heightIn, uncertaintyIn: m.uncertaintyIn, distanceIn: m.distanceIn, viewAngleDeg: m.viewAngleDeg, warnings: m.warnings };
  },
  combine: (ms) => combineSheetMeasurements(ms),
};
