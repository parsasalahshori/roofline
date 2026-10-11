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
