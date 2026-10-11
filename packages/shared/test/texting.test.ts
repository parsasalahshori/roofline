import { expect, test } from 'vitest';
import { BrandInfoSchema, buildCampaign, displayUsPhone, plainRejection } from '../src/texting.ts';

const validBrand = {
  legalName: 'Acme Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '12 Oak St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://acme.com',
  contactFirstName: 'Pat',
  contactLastName: 'Lee',
  contactEmail: 'pat@acme.com',
  contactPhone: '(402) 555-0144',
  contactTitle: 'Owner',
};

function issuesFor(input: Record<string, unknown>) {
  const result = BrandInfoSchema.safeParse({ ...validBrand, ...input });
  return result.success ? [] : result.error.issues;
}

test('a full valid brand parses and normalizes the phone to E.164', () => {
  const result = BrandInfoSchema.safeParse(validBrand);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.contactPhone).toBe('+14025550144');
  }
});

test('an EIN without a dash is normalized to 12-3456789', () => {
  const result = BrandInfoSchema.safeParse({ ...validBrand, ein: '123456789' });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.ein).toBe('12-3456789');
  }
});

test('a short EIN gets the EIN message on the ein path', () => {
  const issues = issuesFor({ ein: '12-34' });
  expect(issues).toContainEqual(
    expect.objectContaining({
      path: ['ein'],
      message: 'Enter your 9-digit EIN, like 12-3456789.',
    }),
  );
});

test('a bare website gets an https scheme', () => {
  const result = BrandInfoSchema.safeParse({ ...validBrand, website: 'acme.com' });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.website).toBe('https://acme.com');
  }
});

test('a full state name is refused with the 2-letter state message', () => {
  const issues = issuesFor({ state: 'Nebraska' });
  expect(issues).toContainEqual(
    expect.objectContaining({
      path: ['state'],
      message: 'Please use the 2-letter state, like NE.',
    }),
  );
});

test('a lowercase 2-letter state is normalized to its uppercase code', () => {
  const result = BrandInfoSchema.safeParse({ ...validBrand, state: 'ne' });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.state).toBe('NE');
  }
});

test('a contact phone with punctuation is stored as E.164', () => {
  const result = BrandInfoSchema.safeParse({ ...validBrand, contactPhone: '(402) 555-0144' });
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.contactPhone).toBe('+14025550144');
  }
});

test('an unknown business type gets the business type message on the businessType path', () => {
  const issues = issuesFor({ businessType: 'sole_prop' });
  expect(issues).toContainEqual(
    expect.objectContaining({
      path: ['businessType'],
      message: 'Pick your business type.',
    }),
  );
});

test('buildCampaign writes the second sample with the company name', () => {
  const campaign = buildCampaign({
    companyName: 'Acme Roofing',
    companyPhone: '+14025550199',
    privacyUrl: 'P',
    termsUrl: 'T',
  });
  expect(campaign.samples[1]).toBe(
    "Hi Maria, it's Acme Roofing. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.",
  );
});

test('buildCampaign shows the company phone in the help message', () => {
  const campaign = buildCampaign({
    companyName: 'Acme Roofing',
    companyPhone: '+14025550199',
    privacyUrl: 'P',
    termsUrl: 'T',
  });
  expect(campaign.helpMessage).toContain('(402) 555-0199');
  expect(campaign.useCase).toBe('MIXED');
  expect(campaign.messageFlow.endsWith('Privacy policy: P. Terms: T.')).toBe(true);
});

test('buildCampaign falls back to "us" when there is no company phone', () => {
  const campaign = buildCampaign({
    companyName: 'Acme Roofing',
    companyPhone: null,
    privacyUrl: 'P',
    termsUrl: 'T',
  });
  expect(campaign.helpMessage).toContain('for help call us.');
});

test('displayUsPhone formats an E.164 US number and leaves other text alone', () => {
  expect(displayUsPhone('+14025550199')).toBe('(402) 555-0199');
  expect(displayUsPhone('abc')).toBe('abc');
});

test('an EIN rejection points at the legal name and EIN fields', () => {
  expect(plainRejection('EIN does not match IRS')).toEqual(
    expect.objectContaining({ fields: ['legalName', 'ein'] }),
  );
});

test('a website rejection points at the website field', () => {
  expect(plainRejection('Website not accessible')).toEqual(
    expect.objectContaining({ fields: ['website'] }),
  );
});

test('a missing rejection reason uses the fallback reason with no fields', () => {
  expect(plainRejection(null)).toEqual({
    reason: 'The phone carriers turned this down. Check your details and send it again.',
    fields: [],
  });
});

test('when several rules match, the first rule wins', () => {
  expect(plainRejection('Tax ID and website')).toEqual(
    expect.objectContaining({ fields: ['legalName', 'ein'] }),
  );
});

test('an opt-in rejection gives the clearer-details reason with no fields', () => {
  expect(plainRejection('Opt-in flow unclear')).toEqual({
    reason:
      "The phone carriers asked for clearer details on how customers agree to texts. We've updated them, so send it again.",
    fields: [],
  });
});
