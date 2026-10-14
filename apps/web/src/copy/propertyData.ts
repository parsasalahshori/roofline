import type { PropertyDataSource } from '@roofline/shared';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const day = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const monthYear = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** The owner record panel: public county records for one home, and a street photo. */
export const propertyData = {
  title: 'Owner records',
  open: 'Owner records',
  hide: 'Hide owner records',
  loading: 'Looking up county records',
  failed: 'We could not load the county records.',
  retry: 'Try again',
  notSetUp: "Owner records aren't set up yet.",
  noRecord: 'No county record was found for this home.',
  owners: 'Owner',
  ownerNone: 'Not listed',
  occupied: 'Lives here',
  occupiedYes: 'Yes, owner gets mail here',
  occupiedNo: 'No, mail goes elsewhere',
  occupiedUnknown: 'Unknown',
  mailing: 'Mailing address',
  parcel: 'Parcel',
  county: 'County',
  yearBuilt: 'Year built',
  livingArea: 'Living area',
  lastSale: 'Last sale',
  assessed: 'Appraised value',
  sqFt: (n: number) => `${n.toLocaleString('en-US')} sq ft`,
  sale: (date: string | null, cents: number | null) =>
    [date !== null ? day.format(new Date(`${date}T00:00:00Z`)) : null, cents !== null ? usd.format(cents / 100) : null]
      .filter((part) => part !== null)
      .join(' · '),
  money: (cents: number) => usd.format(cents / 100),
  source: {
    regrid: 'County records via Regrid',
    'arkansas-gis': 'County records via the Arkansas GIS Office',
    fake: 'Sample records (not a real home)',
  } satisfies Record<PropertyDataSource, string>,
  updated: (iso: string) => `county data from ${monthYear.format(new Date(iso))}`,
  /** Owner names are public record; reaching out from them is regulated (TCPA, Do Not Call). */
  compliance: 'Public record. Do not text or call from it unless they gave you permission.',
  photoAlt: 'Street view of the home',
  photoCredit: (iso: string | null) => (iso !== null ? `Photo from Mapillary, ${monthYear.format(new Date(iso))}` : 'Photo from Mapillary'),
};
