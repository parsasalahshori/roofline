import type { MeasurementView, PriceRange } from '@roofline/shared';

/*
 * Gutters on the instant quote page: the seam. The gutter estimate is being built on its own branch
 * (gutters/build, packages/shared/src/gutters.ts). Until it lands, gutters are offered as a product the homeowner
 * can tick, without a price range (null here). When it lands, work out the feet from the measured roof's eave
 * edges here and price them with its function, then widen with priceRange like the roof and windows.
 */
export function gutterRange(_view: MeasurementView, _pct: number): { feet: number; range: PriceRange } | null {
  return null;
}
