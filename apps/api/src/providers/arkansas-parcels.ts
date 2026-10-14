import type { PropertyRecordView } from '@roofline/shared';
import type { Config } from '../config.ts';
import {
  cents,
  fetchOf,
  getJson,
  isoTime,
  isRecord,
  type JsonRecord,
  oneLine,
  type PropertyData,
  PropertyDataUnavailableError,
  type PropertyLookup,
  ringOf,
  spaced,
  text,
} from './property-data.ts';

/*
 * The Arkansas GIS Office's statewide parcel layer (PARCEL_POLYGON_CAMP), free and open, no key:
 * https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6
 * About 2.1 million parcels for all 75 counties, each with the county's owner name, site address and
 * appraised value from its CAMA (appraisal) system; `camadate` says when the office took that county's data
 * (scheduled loads are twice a year, some counties more often). No mailing address, year built or sale,
 * so `ownerOccupied`, `yearBuilt` and the sale stay null. Point lookups only: an address with no point
 * finds nothing. Chosen with PROPERTY_DATA_PROVIDER=arkansas-gis.
 */

export const ARKANSAS_PARCELS_URL =
  'https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer/6';
const DEFAULT_TIMEOUT_MS = 10_000;
const UNAVAILABLE = "The Arkansas parcel map didn't answer.";
const OUT_FIELDS = ['parcelid', 'ownername', 'adrlabel', 'adrcity', 'adrzip5', 'county', 'totalvalue', 'camadate'];

/** Maps one ArcGIS feature (attributes plus rings in WGS84) to the app's record, or null. */
export function arkansasRecord(feature: unknown, now: Date): PropertyRecordView | null {
  if (!isRecord(feature) || !isRecord(feature.attributes)) return null;
  const a: JsonRecord = feature.attributes;
  const geometry = isRecord(feature.geometry) ? feature.geometry : null;
  const rings = geometry !== null && Array.isArray(geometry.rings) ? geometry.rings : [];
  const owner = text(a.ownername);
  const county = text(a.county);
  return {
    parcelId: text(a.parcelid),
    owners: owner === null ? [] : [owner],
    ownerOccupied: null,
    mailingAddress: null,
    siteAddress: oneLine(text(a.adrlabel), text(a.adrcity), spaced('AR', text(a.adrzip5))),
    county: county === null ? null : `${county} County`,
    yearBuilt: null,
    livingSqFt: null,
    lastSaleDate: null,
    lastSaleCents: null,
    assessedCents: cents(a.totalvalue),
    parcelRing: ringOf(rings[0]),
    source: 'arkansas-gis',
    sourceUpdatedAt: isoTime(a.camadate),
    fetchedAt: now.toISOString(),
  };
}

export class ArkansasParcels implements PropertyData {
  readonly configured = true;
  readonly source = 'arkansas-gis' as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: ReturnType<typeof fetchOf>;
  private readonly now: () => Date;

  constructor(o: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; now?: () => Date } = {}) {
    this.baseUrl = (o.baseUrl ?? ARKANSAS_PARCELS_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = fetchOf(o.fetch);
    this.now = o.now ?? (() => new Date());
  }

  async lookup(query: PropertyLookup, opts?: { timeoutMs?: number }): Promise<PropertyRecordView | null> {
    if (!query.point) return null;
    const params = new URLSearchParams({
      geometry: `${query.point.lng},${query.point.lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: OUT_FIELDS.join(','),
      returnGeometry: 'true',
      geometryPrecision: '6',
      resultRecordCount: '1',
      f: 'json',
    });
    const body = await getJson(this.fetchFn, `${this.baseUrl}/query?${params.toString()}`, {}, opts?.timeoutMs ?? this.timeoutMs, UNAVAILABLE);
    if (body === null) return null;
    // ArcGIS answers its errors with a 200 and an `error` object.
    if (!isRecord(body) || isRecord(body.error) || !Array.isArray(body.features)) {
      throw new PropertyDataUnavailableError(UNAVAILABLE);
    }
    return body.features.length === 0 ? null : arkansasRecord(body.features[0], this.now());
  }
}

/** The Arkansas parcel layer needs no settings; the config is taken so every provider is chosen the same way. */
export function arkansasParcelsFor(config: Config): PropertyData {
  void config;
  return new ArkansasParcels();
}
