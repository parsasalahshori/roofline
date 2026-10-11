import type { BrandField, BrandInfo } from './texting.ts';

export type CampaignInfo = {
  useCase: 'MIXED';
  description: string;
  messageFlow: string;
  samples: string[];
  optInMessage: string;
  optOutMessage: string;
  helpMessage: string;
  privacyUrl: string;
  termsUrl: string;
  hasEmbeddedLinks: true;
  hasEmbeddedPhone: true;
};

export const USE_CASE_LABEL = 'Customer care + marketing (mixed)';

export function displayUsPhone(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!match) return e164;
  return `(${match[1]}) ${match[2]}-${match[3]}`;
}

export function buildCampaign(input: {
  companyName: string;
  companyPhone: string | null;
  privacyUrl: string;
  termsUrl: string;
}): CampaignInfo {
  const N = input.companyName;
  const { privacyUrl, termsUrl } = input;
  const helpPhone = input.companyPhone ? displayUsPhone(input.companyPhone) : 'us';
  return {
    useCase: 'MIXED',
    description: `${N} texts its roofing customers about appointments, estimates and job updates, and sends storm check-ins offering free roof inspections.`,
    messageFlow: `Customers give ${N} their mobile number by phone, in person or on a web form, and agree to receive texts. Customers imported from ${N}'s records were confirmed by the business owner to have agreed. Privacy policy: ${privacyUrl}. Terms: ${termsUrl}.`,
    samples: [
      `Hi Maria, it's ${N}. Your roof inspection is confirmed for Tuesday at 10:00 AM. Reply STOP to opt out.`,
      `Hi Maria, it's ${N}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.`,
    ],
    optInMessage: `${N}: You're signed up for texts about your roof and storm check-ins. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`,
    optOutMessage: `You're unsubscribed from ${N} texts. No more messages will be sent. Reply START to resubscribe.`,
    helpMessage: `${N}: for help call ${helpPhone}. Msg & data rates may apply. Reply STOP to opt out.`,
    privacyUrl,
    termsUrl,
    hasEmbeddedLinks: true,
    hasEmbeddedPhone: true,
  };
}

const FALLBACK_REJECTION = 'The phone carriers turned this down. Check your details and send it again.';

export function plainRejection(failureText: string | null): { reason: string; fields: BrandField[] } {
  if (failureText === null || failureText.trim() === '') {
    return { reason: FALLBACK_REJECTION, fields: [] };
  }
  const text = failureText;
  if (/\b(ein|tax|irs|tin)\b/i.test(text)) {
    return {
      reason:
        "The phone carriers couldn't match your legal name and EIN with IRS records. Use the exact name on your IRS EIN letter.",
      fields: ['legalName', 'ein'],
    };
  }
  if (/website|url|privacy|domain/i.test(text)) {
    return {
      reason:
        "The phone carriers couldn't check your website. It needs to show your business name and a privacy policy (you can use the Roofline page).",
      fields: ['website'],
    };
  }
  if (/address/i.test(text)) {
    return {
      reason: "The phone carriers couldn't confirm your business address. Use the address on your tax records.",
      fields: ['street', 'city', 'state', 'zip'],
    };
  }
  if (/email/i.test(text)) {
    return {
      reason: "Use an email address at your business's own website if you have one.",
      fields: ['contactEmail'],
    };
  }
  if (/phone/i.test(text)) {
    return { reason: 'Check the contact phone number.', fields: ['contactPhone'] };
  }
  if (/opt.?in|consent|sample|message flow/i.test(text)) {
    return {
      reason:
        "The phone carriers asked for clearer details on how customers agree to texts. We've updated them, so send it again.",
      fields: [],
    };
  }
  return { reason: FALLBACK_REJECTION, fields: [] };
}

export const TEXTING_STATES = ['not_started', 'waiting', 'approved', 'needs_fix'] as const;
export type TextingState = (typeof TEXTING_STATES)[number];

export type TextingView = {
  state: TextingState;
  reason: string | null;
  rejectedFields: BrandField[];
  brand: BrandInfo | null;
  defaults: Partial<BrandInfo>;
  submittedAt: string | null;
  approvedAt: string | null;
  number: string | null;
  needsPaymentMethod: boolean;
  needsVerifiedEmail: boolean;
  hostedPolicyUrls: { privacy: string; terms: string };
};
