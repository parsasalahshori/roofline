/**
 * The key two spellings of one address have in common: the street address in lowercase, with
 * punctuation removed and runs of whitespace collapsed to one space, then `|` and the ZIP.
 * `12 Oak St.` and ` 12  OAK ST` in 68102 are both `12 oak st|68102`.
 *
 * Every write to `properties` stores this in `address_key`, and `(company_id, address_key)` is
 * unique, so a company cannot save the same address twice. City and state are not part of it:
 * the ZIP already says where the street is.
 */
export function normalizeAddressKey(addressLine: string, zip: string): string {
  const line = addressLine
    .normalize('NFC')
    .toLowerCase()
    // Letters, digits and the marks that belong to letters stay; everything else that is not a space goes.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${line}|${zip.trim()}`;
}

// The 50 states and DC, code to name. Not an `as const` array: the names are lookup data, not copy.
export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

const US_STATE_CODE_SET: ReadonlySet<string> = new Set(Object.keys(US_STATE_NAMES));
const US_STATE_CODE_BY_NAME: ReadonlyMap<string, string> = new Map(
  Object.entries(US_STATE_NAMES).map(([code, name]) => [name.toLowerCase(), code]),
);

// Turns a typed state, either a 2-letter code or a full name, into its uppercase code, or null.
// Trims, drops one trailing period and ignores case: 'ne', 'NE.', ' nebraska ' all give 'NE'.
export function toUsStateCode(value: string): string | null {
  const cleaned = value.trim().replace(/\.$/, '').trim().toLowerCase();
  if (cleaned === '') return null;
  const upper = cleaned.toUpperCase();
  if (US_STATE_CODE_SET.has(upper)) return upper;
  return US_STATE_CODE_BY_NAME.get(cleaned) ?? null;
}
