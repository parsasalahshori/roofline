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
 * The public proposal as the page reads it: the API's view, plus fields the company payload may carry. The API does not
 * send the extra ones yet, so until it does the page shows the company's name as its wordmark, the default colour and no
 * roof card; nothing is made up in their place.
 */
export type HomeownerView = PublicProposalView & {
  logoUrl?: string | null;
  /** The company's one colour, a hex such as "#ED3A2B". */
  accentColor?: string | null;
  roof?: RoofFacts | null;
};
