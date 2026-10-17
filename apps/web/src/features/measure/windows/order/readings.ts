import { orderGradeMeasured, type MeasuredSize } from '@roofline/shared';

/** One side of a window as the order takes it: the photo that sets it, its reading and the error that comes off it. */
export type SideReading = { reading: MeasuredSize; inches: number; error: number };

export type OrderReadings = {
  width: SideReading;
  height: SideReading;
  /** Whether the method could tell its error at all (a sheet photo with no error known shows none). */
  known: boolean;
};

/**
 * The readings an order size is worked from. `orderSize` (in @roofline/shared) takes, for each side, the photo that is
 * smallest once its own error is off, so this does too: with one error for every photo that is simply the smallest
 * reading. The error is the photo's own on that side, and 0 where the method cannot tell (as `orderSize` counts it).
 * With the size read out of this, the sheet's numbers add up: reading, less error, less the fit allowance.
 */
export function orderReadings(all: readonly MeasuredSize[], factor: number): OrderReadings | null {
  const graded = orderGradeMeasured(all);
  if (graded.length === 0) return null;
  const side = (inches: (m: MeasuredSize) => number, error: (m: MeasuredSize) => number): SideReading => {
    let best = graded[0]!;
    for (const m of graded) if (inches(m) - factor * error(m) < inches(best) - factor * error(best) - 1e-9) best = m;
    return { reading: best, inches: inches(best), error: error(best) };
  };
  const width = side((m) => m.widthIn, (m) => m.uncertaintyIn?.width ?? 0);
  const height = side((m) => m.heightIn, (m) => m.uncertaintyIn?.height ?? 0);
  return { width, height, known: width.reading.uncertaintyIn !== null || height.reading.uncertaintyIn !== null };
}
