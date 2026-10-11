import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Normalizes a US phone number to E.164 (+1XXXXXXXXXX), or returns null.
// Deliberately does not rely on libphonenumber's isValid(): its metadata can
// reject the fictional 555-01XX numbers used in fixtures. Instead the NANP
// shape is checked directly: 10 national digits, area code and exchange both
// starting with 2-9.
export function toE164(input: string): string | null {
  if (input.trim() === '') return null;
  const parsed = parsePhoneNumberFromString(input, 'US');
  if (!parsed || parsed.countryCallingCode !== '1') return null;
  const national = parsed.nationalNumber;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) return null;
  return `+1${national}`;
}
