import type { Ring } from './roof.ts';

/** Where a property's owner and parcel record came from (providers/property-data.ts on the API). */
export type PropertyDataSource = 'regrid' | 'arkansas-gis' | 'fake';

/**
 * One parcel's public-record facts, as `GET /api/properties/:id/record` answers them. Every field the county
 * does not publish is null. Owner names are public record: the app shows them, and never texts or calls from them.
 */
export type PropertyRecordView = {
  /** The county's parcel number (APN). */
  parcelId: string | null;
  /** Owner names as the county records them, first owner first. Empty when the county lists none. */
  owners: string[];
  /** True when the owner's mailing address is this house (or a homestead exemption is on file); null when unknown. */
  ownerOccupied: boolean | null;
  /** The owner's mailing address on one line, or null. */
  mailingAddress: string | null;
  /** The parcel's own (situs) address on one line, or null. */
  siteAddress: string | null;
  county: string | null;
  yearBuilt: number | null;
  livingSqFt: number | null;
  /** The last recorded sale, `YYYY-MM-DD`, or null. */
  lastSaleDate: string | null;
  /** The last recorded sale price in whole cents, or null. */
  lastSaleCents: number | null;
  /** The county's total appraised value in whole cents, or null. */
  assessedCents: number | null;
  /** The parcel's outer boundary, [lng, lat] points, or null. */
  parcelRing: Ring | null;
  source: PropertyDataSource;
  /** When the provider last took the county's data, ISO 8601, or null when it does not say. */
  sourceUpdatedAt: string | null;
  /** When this record was fetched, ISO 8601. */
  fetchedAt: string;
};

/** The nearest street-level photo of a point (Mapillary, CC BY-SA 4.0). */
export type StreetImageView = {
  id: string;
  /** A short-lived image URL: ask for the record again rather than storing it. */
  thumbUrl: string;
  /** When the photo was taken, ISO 8601, or null. */
  capturedAt: string | null;
  /** The photo's page on the provider (the attribution link). */
  pageUrl: string;
};

/** `GET /api/properties/:id/record`. */
export type PropertyRecordResponse = {
  /** False when no property data provider is set up: `record` is then null. */
  configured: boolean;
  record: PropertyRecordView | null;
  /** Null when street imagery is not set up, the home has no point, or no photo is near it. */
  streetImage: StreetImageView | null;
};
