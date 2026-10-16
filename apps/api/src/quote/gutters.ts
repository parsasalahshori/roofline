import { eaveHeight, measureGutters, priceGutters, priceRange, type MeasurementView, type PriceRange } from '@roofline/shared';

/*
 * Gutters on the instant quote page: the measured roof's eaves (packages/shared/src/gutters.ts, the same runs, corners
 * and downspouts the estimator's gutter screen shows, with no adjustments), priced with the gutter tiers and widened
 * like the roof and windows. The feet are rounded to the nearest 10: a size, not a measurement to quote from.
 */
export function gutterRange(view: MeasurementView, pct: number, eaveHeightM: number | null): { feet: number; range: PriceRange } | null {
  if (view.drawMode || view.roof === null) return null;
  const measured = measureGutters(view.roof, eaveHeight({ eaveHeightM }), null);
  const feet = measured.totals.gutterFt;
  if (!(feet > 0)) return null;
  const range = priceRange(priceGutters(measured).map((q) => q.totalCents), pct);
  return range === null ? null : { feet: Math.max(10, Math.round(feet / 10) * 10), range };
}
