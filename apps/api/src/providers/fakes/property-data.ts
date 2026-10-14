import type { PropertyRecordView, Ring } from '@roofline/shared';
import { type PropertyData, PropertyDataUnavailableError, type PropertyLookup } from '../property-data.ts';

/*
 * Property data with no network: a fictional parcel record for any house, the same one every time for the
 * same point (or address). The names are made up and the parcel numbers are not any county's. An address
 * containing "nowhere" (and a point south of the equator) finds no parcel; "outage" fails like a dead provider.
 */

const FIRST = ['Jordan', 'Casey', 'Riley', 'Morgan', 'Avery', 'Quinn', 'Harper', 'Rowan'];
const LAST = ['Example', 'Sample', 'Placeholder', 'Testwood', 'Fictional', 'Demoby'];
const STREETS = ['Ridgeview Dr', 'Prairie Wind Ln', 'Summit Oak Ct', 'Copper Ridge Rd', 'Meadowlark Way'];

function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A small square lot (about 30 m a side) around the point. */
function lotAround(lng: number, lat: number): Ring {
  const d = 0.00014;
  const r = (x: number) => Math.round(x * 1e6) / 1e6;
  return [
    [r(lng - d), r(lat - d)],
    [r(lng + d), r(lat - d)],
    [r(lng + d), r(lat + d)],
    [r(lng - d), r(lat + d)],
    [r(lng - d), r(lat - d)],
  ];
}

export type PropertyDataCall = { query: PropertyLookup };

export class FakePropertyData implements PropertyData {
  readonly configured = true;
  readonly source = 'fake' as const;
  readonly calls: PropertyDataCall[] = [];
  private failures = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Makes the next `n` lookups throw PropertyDataUnavailableError. */
  failNext(n = 1): void {
    this.failures += n;
  }

  async lookup(query: PropertyLookup): Promise<PropertyRecordView | null> {
    this.calls.push({ query });
    if (this.failures > 0) {
      this.failures--;
      throw new PropertyDataUnavailableError('Fake property data is unavailable.');
    }
    const line = query.address?.line ?? '';
    if (/outage/i.test(line)) throw new PropertyDataUnavailableError('Fake property data is unavailable.');
    if (/nowhere/i.test(line)) return null;
    if (query.point && query.point.lat < 0) return null;
    if (!query.point && !query.address) return null;

    const key = query.point
      ? `${query.point.lat.toFixed(5)},${query.point.lng.toFixed(5)}`
      : `${line}|${query.address?.zip ?? ''}`.toLowerCase();
    const h = fnv1a(key);
    const first = FIRST[h % FIRST.length]!;
    const last = LAST[Math.floor(h / 8) % LAST.length]!;
    const occupied = h % 3 !== 0;
    const site = query.address
      ? `${query.address.line}, ${query.address.city}, ${query.address.state} ${query.address.zip}`
      : null;
    const mailing = occupied ? site : `PO Box ${100 + (h % 900)}, Faketown, ZZ 00000`;
    const saleYear = 2000 + (h % 24);
    return {
      parcelId: `FAKE-${String(h % 1_000_000).padStart(6, '0')}`,
      owners: occupied ? [`${last} ${first}`, `${last} ${FIRST[(h + 3) % FIRST.length]!}`] : [`${STREETS[h % STREETS.length]!} Holdings LLC`],
      ownerOccupied: occupied,
      mailingAddress: mailing,
      siteAddress: site,
      county: 'Example County',
      yearBuilt: 1960 + (h % 60),
      livingSqFt: 1200 + (h % 2400),
      lastSaleDate: `${saleYear}-0${1 + (h % 9)}-15`,
      lastSaleCents: (120_000 + (h % 280_000)) * 100,
      assessedCents: (90_000 + (h % 250_000)) * 100,
      parcelRing: query.point ? lotAround(query.point.lng, query.point.lat) : null,
      source: 'fake',
      sourceUpdatedAt: '2026-09-01T00:00:00.000Z',
      fetchedAt: this.now().toISOString(),
    };
  }
}
