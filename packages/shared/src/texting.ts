import { z } from 'zod';
import { toUsStateCode } from './address.ts';
import { toE164 } from './phone.ts';

export const BUSINESS_TYPES = ['llc', 'corporation', 'partnership', 'non_profit'] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const BRAND_FIELDS = [
  'legalName',
  'ein',
  'businessType',
  'street',
  'city',
  'state',
  'zip',
  'website',
  'contactFirstName',
  'contactLastName',
  'contactEmail',
  'contactPhone',
  'contactTitle',
] as const;
export type BrandField = (typeof BRAND_FIELDS)[number];
export type BrandInfo = Omit<Record<BrandField, string>, 'businessType'> & {
  businessType: BusinessType;
};

// The plain-English message for each field. Every failure of a field's rule carries its message.
const FIELD_MESSAGE: Record<BrandField, string> = {
  legalName: 'Enter the legal name on your IRS paperwork.',
  ein: 'Enter your 9-digit EIN, like 12-3456789.',
  businessType: 'Pick your business type.',
  street: 'Enter your business address.',
  city: 'Enter your business address.',
  state: 'Please use the 2-letter state, like NE.',
  zip: 'Please enter a ZIP code, like 68102.',
  website: 'Enter your website, like https://acme.com.',
  contactFirstName: 'Please fill this in.',
  contactLastName: 'Please fill this in.',
  contactTitle: 'Please fill this in.',
  contactEmail: 'Please enter a valid email address.',
  contactPhone: "That doesn't look like a US phone number.",
};

// A string that is trimmed before any rule runs. A missing or non-string value gets the field's message.
function trimmedText(field: BrandField) {
  return z.string({ error: FIELD_MESSAGE[field] }).trim();
}

const EIN_PATTERN = /^\d{2}-?\d{7}$/;
const WEBSITE_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

// Validates the brand form. Output is a BrandInfo: EIN as 12-3456789, state as its uppercase code,
// website with a scheme, phone as E.164. Input is whatever the form sent.
export const BrandInfoSchema: z.ZodType<BrandInfo, unknown> = z.object({
  legalName: trimmedText('legalName')
    .min(2, { error: FIELD_MESSAGE.legalName })
    .max(120, { error: FIELD_MESSAGE.legalName }),
  ein: trimmedText('ein')
    .regex(EIN_PATTERN, { error: FIELD_MESSAGE.ein })
    .transform((value) => {
      const digits = value.replace('-', '');
      return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }),
  businessType: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : value),
    z.enum(BUSINESS_TYPES, { error: FIELD_MESSAGE.businessType }),
  ),
  street: trimmedText('street').min(1, { error: FIELD_MESSAGE.street }).max(120, { error: FIELD_MESSAGE.street }),
  city: trimmedText('city').min(1, { error: FIELD_MESSAGE.city }).max(60, { error: FIELD_MESSAGE.city }),
  state: trimmedText('state')
    .regex(/^[A-Za-z]{2}$/, { error: FIELD_MESSAGE.state })
    .transform((value, ctx) => {
      const code = toUsStateCode(value);
      if (code === null) {
        ctx.addIssue({
          code: 'custom',
          message: FIELD_MESSAGE.state,
          input: value,
        });
        return z.NEVER;
      }
      return code;
    }),
  zip: trimmedText('zip').regex(/^\d{5}$/, { error: FIELD_MESSAGE.zip }),
  website: trimmedText('website').transform((value, ctx) => {
    const candidate = WEBSITE_SCHEME.test(value) ? value : `https://${value}`;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: FIELD_MESSAGE.website,
        input: value,
      });
      return z.NEVER;
    }
    const isWebScheme = url.protocol === 'http:' || url.protocol === 'https:';
    if (!isWebScheme || !url.hostname.includes('.')) {
      ctx.addIssue({
        code: 'custom',
        message: FIELD_MESSAGE.website,
        input: value,
      });
      return z.NEVER;
    }
    return candidate;
  }),
  contactFirstName: trimmedText('contactFirstName')
    .min(1, { error: FIELD_MESSAGE.contactFirstName })
    .max(60, { error: FIELD_MESSAGE.contactFirstName }),
  contactLastName: trimmedText('contactLastName')
    .min(1, { error: FIELD_MESSAGE.contactLastName })
    .max(60, { error: FIELD_MESSAGE.contactLastName }),
  contactEmail: trimmedText('contactEmail').email({
    error: FIELD_MESSAGE.contactEmail,
  }),
  contactPhone: trimmedText('contactPhone').transform((value, ctx) => {
    const e164 = toE164(value);
    if (e164 === null) {
      ctx.addIssue({
        code: 'custom',
        message: FIELD_MESSAGE.contactPhone,
        input: value,
      });
      return z.NEVER;
    }
    return e164;
  }),
  contactTitle: trimmedText('contactTitle')
    .min(1, { error: FIELD_MESSAGE.contactTitle })
    .max(60, { error: FIELD_MESSAGE.contactTitle }),
});

// Campaign text, rejection reasons and the view live in texting-campaign.ts.
export * from './texting-campaign.ts';
