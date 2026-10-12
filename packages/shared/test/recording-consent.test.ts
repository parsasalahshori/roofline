import { describe, expect, test } from 'vitest';
import {
  ALL_PARTY_STATES,
  consentRegime,
  disclosureGreeting,
  stateForAreaCode,
} from '../src/recording-consent.ts';

const SAMPLES: Array<[string, string]> = [
  ...['213', '310', '415', '619', '714', '916', '408', '510', '805', '949'].map((c): [string, string] => [c, 'CA']),
  ...['212', '315', '516', '518', '585', '607', '631', '646', '716', '718', '845', '914', '917'].map((c): [string, string] => [c, 'NY']),
  ...['305', '407', '561', '754', '786', '813', '904', '954'].map((c): [string, string] => [c, 'FL']),
  ...['312', '217', '309', '618', '630', '708', '773', '815', '847'].map((c): [string, string] => [c, 'IL']),
  ...['206', '253', '360', '425', '509', '564'].map((c): [string, string] => [c, 'WA']),
  ...['503', '541', '971'].map((c): [string, string] => [c, 'OR']),
  ...['215', '267', '412', '484', '610', '717', '724', '814'].map((c): [string, string] => [c, 'PA']),
  ...['313', '248', '517', '616', '734', '810', '906', '989'].map((c): [string, string] => [c, 'MI']),
  ['406', 'MT'],
  ['603', 'NH'],
  ...['617', '508', '413', '774', '781', '978', '339', '351'].map((c): [string, string] => [c, 'MA']),
  ...['410', '240', '301', '443', '667'].map((c): [string, string] => [c, 'MD']),
  ...['203', '475', '860', '959'].map((c): [string, string] => [c, 'CT']),
  ...['402', '531'].map((c): [string, string] => [c, 'NE']),
  ...['214', '281', '512', '713', '817', '832', '972'].map((c): [string, string] => [c, 'TX']),
  ...['602', '480', '623', '928'].map((c): [string, string] => [c, 'AZ']),
  ...['702', '775'].map((c): [string, string] => [c, 'NV']),
  ...['303', '719', '720', '970'].map((c): [string, string] => [c, 'CO']),
  ...['404', '470', '678', '770', '912'].map((c): [string, string] => [c, 'GA']),
  ['202', 'DC'],
];

describe('ALL_PARTY_STATES', () => {
  test('is exactly the 12 listed states', () => {
    expect([...ALL_PARTY_STATES]).toEqual(['CA', 'CT', 'FL', 'IL', 'MD', 'MA', 'MI', 'MT', 'NH', 'OR', 'PA', 'WA']);
  });
});

describe('stateForAreaCode', () => {
  test.each(SAMPLES)('%s -> %s', (npa, state) => {
    expect(stateForAreaCode(npa)).toBe(state);
  });
  test.each(['800', '833', '844', '855', '866', '877', '888', '416', '604', '514', '876', '12', '1234', 'abc', '', '   '])(
    '%j -> null',
    (npa) => {
      expect(stateForAreaCode(npa)).toBeNull();
    },
  );
  test('trims input', () => {
    expect(stateForAreaCode(' 415 ')).toBe('CA');
  });
});

describe('consentRegime', () => {
  test('caller in CA, company NE -> all_party', () => {
    expect(consentRegime({ callerE164: '+14155550100', companyState: 'NE' })).toBe('all_party');
  });
  test('caller NE, company TX -> one_party', () => {
    expect(consentRegime({ callerE164: '+14025550100', companyState: 'TX' })).toBe('one_party');
  });
  test('lowercase company state wa -> all_party', () => {
    expect(consentRegime({ callerE164: '+14025550100', companyState: 'wa' })).toBe('all_party');
  });
  test('padded company state is trimmed', () => {
    expect(consentRegime({ callerE164: '+14025550100', companyState: ' fl ' })).toBe('all_party');
  });
  test('transfer state FL -> all_party', () => {
    expect(consentRegime({ callerE164: '+14025550100', companyState: 'TX', transferState: 'FL' })).toBe('all_party');
  });
  test('null company, caller TX -> one_party', () => {
    expect(consentRegime({ callerE164: '+12145550100', companyState: null })).toBe('one_party');
  });
  test('garbage caller does not throw', () => {
    expect(consentRegime({ callerE164: 'abc', companyState: 'CA' })).toBe('all_party');
    expect(consentRegime({ callerE164: 'abc', companyState: null })).toBe('one_party');
    expect(consentRegime({ callerE164: '', companyState: null, transferState: undefined })).toBe('one_party');
  });
  test('unknown state strings contribute nothing', () => {
    expect(consentRegime({ callerE164: '+14025550100', companyState: 'California', transferState: 'ZZ' })).toBe('one_party');
  });
  test('caller in MI -> all_party', () => {
    expect(consentRegime({ callerE164: '+13135550100', companyState: null })).toBe('all_party');
  });
  test('toll-free caller contributes nothing', () => {
    expect(consentRegime({ callerE164: '+18005550100', companyState: 'TX' })).toBe('one_party');
  });
});

describe('disclosureGreeting', () => {
  test('exact wording', () => {
    const g = disclosureGreeting('Acme Roofing');
    expect(g).toBe("Thanks for calling Acme Roofing. I'm Acme Roofing's virtual assistant, and this call is recorded. How can I help?");
    expect(g).toContain('virtual assistant');
    expect(g).toContain('recorded');
  });
  test('trims and falls back for empty names', () => {
    expect(disclosureGreeting('  Acme  ')).toContain('calling Acme.');
    const g = disclosureGreeting('   ');
    expect(g).toContain('our team');
    expect(g).toContain('virtual assistant');
    expect(g).toContain('recorded');
  });
});
