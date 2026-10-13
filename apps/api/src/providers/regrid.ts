import type { PropertyRecordView } from '@roofline/shared';
import type { Config } from '../config.ts';
import {
  cents,
  fetchOf,
  getJson,
  isoDay,
  isoTime,
  isRecord,
  type JsonRecord,
  num,
  oneLine,
  outerRingOfGeoJson,
  ownerOccupied,
  type PropertyData,
  type PropertyLookup,
  spaced,
  text,
  year,
} from './property-data.ts';

/*
 * Regrid's Parcel API v2 (https://support.regrid.com/api/parcel-api-endpoints): nationwide county parcel
 * records with owner names, mailing address, year built, last sale and the parcel boundary.
 * - GET /api/v2/parcels/point?lat=&lon=&limit=1, or /parcels/address?query=&limit=1 when there is no point.
 * - The token goes in the `x-regrid-token` header (never in the URL, so it cannot end up in a log).
 * - The answer is `{ parcels: { type: 'FeatureCollection', features: [{ geometry, properties: { fields } }] } }`,
 *   where `fields` holds the Standard/Premium schema columns (owner, owner2, mailadd, mail_city, mail_state2,
 *   mail_zip, address, scity, state2, szip, county, parcelnumb, yearbuilt, area_building, saledate,
 *   saleprice, parval, homestead_exemption, ll_last_refresh).
 * - Self-serve plans bill per parcel record returned, so the app asks only when a person opens the record.
 */

const DEFAULT_BASE_URL = 'https://app.regrid.com/api/v2';
const DEFAULT_TIMEOUT_MS = 8000;
const UNAVAILABLE = "Regrid didn't answer.";

/** A homestead exemption value that means one is on file ("Y", "Yes", "true", "1", or an amount above zero). */
function homestead(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const n = num(value);
  if (n !== null) return n > 0;
  const t = text(value)?.toUpperCase() ?? null;
  if (t === null) return null;
  if (['N', 'NO', 'FALSE', 'NONE'].includes(t)) return false;
  return true;
}

/** Maps one Regrid parcel feature to the app's record, or null when it is not a parcel feature. */
export function regridRecord(feature: unknown, now: Date): PropertyRecordView | null {
  if (!isRecord(feature) || !isRecord(feature.properties)) return null;
  const f: JsonRecord = isRecord(feature.properties.fields) ? feature.properties.fields : {};

  const owners: string[] = [];
  for (const key of ['owner', 'owner2', 'owner3', 'owner4']) {
    const name = text(f[key]);
    if (name !== null && !owners.includes(name)) owners.push(name);
  }

  const mailStreet = text(f.mailadd);
  const mailZip = text(f.mail_zip);
  const siteStreet = text(f.address);
  const siteZip = text(f.szip5) ?? text(f.szip);

  return {
    parcelId: text(f.parcelnumb),
    owners,
    ownerOccupied: ownerOccupied({ homestead: homestead(f.homestead_exemption), mailStreet, mailZip, siteStreet, siteZip }),
    mailingAddress: oneLine(
      mailStreet,
      text(f.mail_address2),
      text(f.mail_city),
      spaced(text(f.mail_state2), mailZip),
    ),
    siteAddress: oneLine(siteStreet, text(f.scity), spaced(text(f.state2), siteZip)),
    county: text(f.county),
    yearBuilt: year(f.yearbuilt, now),
    livingSqFt: ((n) => (n !== null && n > 0 ? Math.round(n) : null))(num(f.area_building)),
    lastSaleDate: isoDay(f.saledate),
    lastSaleCents: cents(f.saleprice),
    assessedCents: cents(f.parval),
    parcelRing: outerRingOfGeoJson(feature.geometry),
    source: 'regrid',
    sourceUpdatedAt: isoTime(f.ll_last_refresh),
    fetchedAt: now.toISOString(),
  };
}

export class RegridPropertyData implements PropertyData {
  readonly configured = true;
  readonly source = 'regrid' as const;
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: ReturnType<typeof fetchOf>;
  private readonly now: () => Date;

  constructor(o: { token: string; fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; now?: () => Date }) {
    this.token = o.token;
    this.baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = fetchOf(o.fetch);
    this.now = o.now ?? (() => new Date());
  }

  async lookup(query: PropertyLookup, opts?: { timeoutMs?: number }): Promise<PropertyRecordView | null> {
    let url: string;
    if (query.point) {
      const params = new URLSearchParams({
        lat: String(query.point.lat),
        lon: String(query.point.lng),
        limit: '1',
      });
      url = `${this.baseUrl}/parcels/point?${params.toString()}`;
    } else if (query.address) {
      const a = query.address;
      const params = new URLSearchParams({ query: `${a.line}, ${a.city}, ${a.state} ${a.zip}`, limit: '1' });
      url = `${this.baseUrl}/parcels/address?${params.toString()}`;
    } else {
      return null;
    }
    const body = await getJson(
      this.fetchFn,
      url,
      { 'x-regrid-token': this.token },
      opts?.timeoutMs ?? this.timeoutMs,
      UNAVAILABLE,
    );
    if (body === null) return null;
    const parcels = isRecord(body) ? body.parcels : undefined;
    const features = isRecord(parcels) && Array.isArray(parcels.features) ? parcels.features : null;
    if (features === null) return null;
    return features.length === 0 ? null : regridRecord(features[0], this.now());
  }
}

export function regridFor(config: Config): PropertyData | null {
  return config.REGRID_API_TOKEN ? new RegridPropertyData({ token: config.REGRID_API_TOKEN }) : null;
}
