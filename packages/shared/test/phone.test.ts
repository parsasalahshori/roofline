import { describe, expect, test } from 'vitest';
import { NON_US_NANP_AREA_CODES, textability, toE164, TOLL_FREE_AREA_CODES } from '../src/phone.ts';

test.each(['(402) 555-0144', '402.555.0144', '+1 402 555 0144', '4025550144'])('%s → +14025550144', (s) => {
  expect(toE164(s)).toBe('+14025550144');
});
test.each(['555-0144', '', 'call me', '+1 000 000 0000'])('%s → null', (s) => expect(toE164(s)).toBeNull());

// Pinned in Task 10 (the Task 2 ruling): the check is the NANP shape, not libphonenumber's metadata.
test('a fictional area code is accepted: (555) 555-0144 → +15555550144', () => {
  expect(toE164('(555) 555-0144')).toBe('+15555550144');
});
test('an exchange that starts with 1 is not a US number: (402) 155-0144 → null', () => {
  expect(toE164('(402) 155-0144')).toBeNull();
});
test('a non-US country code is rejected: +44 20 7946 0958 → null', () => {
  expect(toE164('+44 20 7946 0958')).toBeNull();
});
test('eleven digits that do not start with the country code 1 are rejected: 4025550144 4 → null', () => {
  expect(toE164('4025550144 4')).toBeNull();
});

// Literal copies of the lists in the brief, so a wrong export fails a test rather than passing by construction.
const CANADA = [
  '204', '226', '236', '249', '250', '257', '263', '289', '306', '343', '354', '365', '367', '368', '382', '387',
  '403', '416', '418', '428', '431', '437', '438', '450', '460', '468', '474', '506', '514', '519', '548', '579',
  '581', '584', '587', '604', '613', '639', '647', '672', '683', '705', '709', '742', '753', '778', '780', '782',
  '807', '819', '825', '867', '873', '879', '902', '905', '942',
];
const OTHER_NANP = [
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809',
  '829', '849', '868', '869', '876',
];
const TOLL_FREE = ['800', '833', '844', '855', '866', '877', '888', '900'];
const US_TERRITORIES = ['340', '670', '671', '684', '787', '939'];

describe('textability', () => {
  test('the toll-free list is the eight literal codes', () => {
    expect(TOLL_FREE_AREA_CODES).toEqual(TOLL_FREE);
  });

  test('the non-US list has 57 Canadian and 21 other NANP codes, and nothing else', () => {
    expect(CANADA).toHaveLength(57);
    expect(OTHER_NANP).toHaveLength(21);
    expect(NON_US_NANP_AREA_CODES).toHaveLength(78);
    expect([...NON_US_NANP_AREA_CODES].sort()).toEqual([...CANADA, ...OTHER_NANP].sort());
  });

  test('no code is in both the toll-free and the non-US list', () => {
    const overlap = TOLL_FREE_AREA_CODES.filter((code) => NON_US_NANP_AREA_CODES.includes(code));
    expect(overlap).toEqual([]);
  });

  test('every code in both lists is three digits starting with 2-9', () => {
    for (const code of [...TOLL_FREE_AREA_CODES, ...NON_US_NANP_AREA_CODES]) {
      expect(code).toMatch(/^[2-9]\d{2}$/);
    }
  });

  test('a toll-free number is toll_free', () => {
    expect(textability('+18005550100')).toBe('toll_free');
  });

  test.each(TOLL_FREE)('area code %s is toll_free', (code) => {
    expect(textability(`+1${code}5550100`)).toBe('toll_free');
  });

  test('a Canadian number is not_us', () => {
    expect(textability('+14165550100')).toBe('not_us');
  });

  test('a Jamaican (876) number is not_us', () => {
    expect(textability('+18765550100')).toBe('not_us');
  });

  test.each(CANADA)('Canadian area code %s is not_us', (code) => {
    expect(textability(`+1${code}5550100`)).toBe('not_us');
  });

  test.each(OTHER_NANP)('other NANP area code %s is not_us', (code) => {
    expect(textability(`+1${code}5550100`)).toBe('not_us');
  });

  test('a US territory number (787) is ok', () => {
    expect(textability('+17875550100')).toBe('ok');
  });

  test.each(US_TERRITORIES)('US territory area code %s is ok', (code) => {
    expect(textability(`+1${code}5550100`)).toBe('ok');
  });

  test('an ordinary US number is ok', () => {
    expect(textability('+14025550144')).toBe('ok');
  });

  test('a fictional area code is ok, matching the toE164 pin', () => {
    expect(textability('+15555550144')).toBe('ok');
  });

  test('a UK number is invalid', () => {
    expect(textability('+4402071234567')).toBe('invalid');
  });

  test.each([
    '',
    'abc',
    '4025550144',
    '14025550144',
    '+1402555014',
    '+140255501445',
    '+11025550144',
    '+10025550144',
    '+14021550144',
    '+14020550144',
    ' +14025550144',
    '+14025550144 ',
    '+1 402 555 0144',
    '+442071234567',
  ])('%j is invalid', (value) => {
    expect(textability(value)).toBe('invalid');
  });

  test('undefined is invalid', () => {
    expect(textability(undefined as unknown as string)).toBe('invalid');
  });

  test('null is invalid', () => {
    expect(textability(null as unknown as string)).toBe('invalid');
  });

  test('agrees with toE164 for a local US number', () => {
    const e164 = toE164('(402) 555-0144');
    expect(e164).toBe('+14025550144');
    expect(textability(e164 as string)).toBe('ok');
  });

  test('agrees with toE164 for a toll-free number', () => {
    const e164 = toE164('+1 800 555 0100');
    expect(e164).toBe('+18005550100');
    expect(textability(e164 as string)).toBe('toll_free');
  });
});
