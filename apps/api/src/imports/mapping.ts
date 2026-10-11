import { IMPORT_FIELDS } from '@roofline/shared';
import type { ImportField, ImportMapping } from '@roofline/shared';

/** Lowercases a header, turns every non a-z0-9 character into a space, collapses runs of spaces and trims. */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const HEADER_SYNONYMS: Record<ImportField, readonly string[]> = {
  name: ['name', 'full name', 'customer', 'customer name', 'client', 'client name', 'contact', 'contact name'],
  firstName: ['first', 'first name', 'firstname', 'fname', 'given name'],
  lastName: ['last', 'last name', 'lastname', 'lname', 'surname', 'family name'],
  phone: [
    'phone',
    'phone number',
    'mobile',
    'mobile phone',
    'cell',
    'cell phone',
    'cellphone',
    'telephone',
    'tel',
    'primary phone',
    'home phone',
  ],
  phone2: ['phone 2', 'alt phone', 'other phone', 'work phone', 'secondary phone'],
  email: ['email', 'e mail', 'email address', 'mail'],
  street: ['address', 'street', 'street address', 'address 1', 'address line 1', 'address1', 'property address'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  zip: ['zip', 'zip code', 'zipcode', 'postal code', 'postcode'],
  notes: ['notes', 'note', 'comments', 'comment', 'description'],
  stage: ['stage', 'status', 'pipeline stage', 'job stage', 'deal stage'],
};

/**
 * Maps import fields to column indexes by normalized header. Fields are processed in IMPORT_FIELDS order and each
 * column is used at most once. phone2 may also take a column that matches the phone synonyms (e.g. "Home Phone")
 * once phone has been taken. Unknown headers stay unmapped.
 */
export function autoMap(headers: readonly string[]): ImportMapping {
  const normalized = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapping: ImportMapping = {};

  for (const field of IMPORT_FIELDS) {
    const accepted: readonly string[] =
      field === 'phone2' ? [...HEADER_SYNONYMS.phone2, ...HEADER_SYNONYMS.phone] : HEADER_SYNONYMS[field];
    const index = normalized.findIndex((header, i) => !used.has(i) && accepted.includes(header));
    if (index !== -1) {
      used.add(index);
      mapping[field] = index;
    }
  }

  return mapping;
}
