import type { LngLat, PublicProposalView } from '@roofline/shared';

/** What the company's data says about the roof. Every part is optional: a part that is missing is simply not shown. */
export type RoofFacts = {
  /** Roofing squares (100 sq ft each). */
  squares?: number | null;
  /** Rise over 12: 6 reads "6/12". */
  pitchX12?: number | null;
  /** The largest hail stone recorded at the address, in inches. */
  hailInches?: number | null;
  /** How many photos the inspection took. */
  photoCount?: number | null;
  /** The measured outline, for the picture of the home from above. */
  outline?: { center: LngLat; ring: LngLat[] } | null;
};

/**
 * The public proposal as the page reads it: the API's view (which carries the company's name, phone, one colour and logo),
 * plus the roof facts the company payload may carry. The API does not send the roof yet, so until it does the page shows no
 * roof card; nothing is made up in its place. A payload without the colour or the logo reads as the default blue and the
 * company's name as the wordmark.
 */
export type HomeownerView = PublicProposalView & {
  roof?: RoofFacts | null;
};
