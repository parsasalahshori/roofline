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

// Toll-free NANP area codes. A number here can't receive texts from a US sender.
export const TOLL_FREE_AREA_CODES: readonly string[] = ['800', '833', '844', '855', '866', '877', '888', '900'];

// NANP area codes that belong to a country other than the US. US territories (340, 670, 671,
// 684, 787, 939) are not listed: they are textable, so they are 'ok'.
export const NON_US_NANP_AREA_CODES: readonly string[] = [
  // Canada (57)
  '204', '226', '236', '249', '250', '257', '263', '289', '306', '343', '354', '365', '367', '368', '382', '387',
  '403', '416', '418', '428', '431', '437', '438', '450', '460', '468', '474', '506', '514', '519', '548', '579',
  '581', '584', '587', '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782',
  '807', '819', '825', '867', '873', '879', '902', '905', '942',
  // Other NANP countries (21)
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809',
  '829', '849', '868', '869', '876',
];

const TOLL_FREE_SET: ReadonlySet<string> = new Set(TOLL_FREE_AREA_CODES);
const NON_US_NANP_SET: ReadonlySet<string> = new Set(NON_US_NANP_AREA_CODES);

// Says whether a number can receive a text from a US sender. The input must already be
// E.164 (+1 and ten digits), as toE164 returns it; it is matched exactly, with no trimming.
// - 'ok': a US number we can text. This includes US territories (787, 340 and so on) and
//   fictional area codes such as 555, which the test fixtures use.
// - 'toll_free': an 800-style number, which can't get these texts.
// - 'not_us': a Canadian or other NANP number outside the US.
// - 'invalid': not an E.164 NANP number at all (wrong country code, bad digits, formatting, or
//   an area code or exchange that starts with 0 or 1).
export function textability(e164: string): 'ok' | 'toll_free' | 'not_us' | 'invalid' {
  if (typeof e164 !== 'string') return 'invalid';
  const match = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(e164);
  if (!match) return 'invalid';
  const areaCode = match[1] as string;
  if (TOLL_FREE_SET.has(areaCode)) return 'toll_free';
  if (NON_US_NANP_SET.has(areaCode)) return 'not_us';
  return 'ok';
}
