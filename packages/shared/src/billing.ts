import { z } from 'zod';
import type { CompanyStatus } from './enums.ts';

// ---------------------------------------------------------------------------
// Constants and metering math (top half)
// ---------------------------------------------------------------------------

export const USAGE_KINDS = [
  'ai_call_minute',
  'sms_segment',
  'mms',
  'exact_report',
  'texting_registration_fee',
  'phone_number_month',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const METERS = ['ai_call_minute', 'sms_segment'] as const;
export type Meter = (typeof METERS)[number];

export const INVOICE_KINDS = ['exact_report', 'texting_registration_fee', 'phone_number_month'] as const;

export const METER_EVENT_NAME: Record<Meter, string> = {
  ai_call_minute: 'roofline_ai_call_minute',
  sms_segment: 'roofline_sms_segment',
};

export type PlanConfig = {
  key: string;
  name: string;
  monthly_price_cents: number;
  included: { ai_call_minutes: number; sms_segments: number };
  overage_cents: { ai_call_minute: number; sms_segment: number };
};

export type BillingConfig = {
  plans: PlanConfig[];
  exact_report_markup_pct: number;
  pass_through_cents: {
    brand_registration: number;
    campaign_vetting: number;
    campaign_monthly: number;
    phone_number_monthly: number;
  };
};

export function priceLookupKeys(planKey: string): {
  monthly: string;
  ai_call_minute: string;
  sms_segment: string;
} {
  return {
    monthly: `roofline_${planKey}_monthly`,
    ai_call_minute: `roofline_${planKey}_ai_call_minute`,
    sms_segment: `roofline_${planKey}_sms_segment`,
  };
}

const LOOKUP_KEY_PATTERN = /^roofline_([a-z][a-z0-9]{1,30})_(monthly|ai_call_minute|sms_segment)$/;

export function planFromLookupKey(lookupKey: string): string | null {
  const match = LOOKUP_KEY_PATTERN.exec(lookupKey);
  return match?.[1] ?? null;
}

export function meteredTiers(
  plan: PlanConfig,
  meter: Meter,
): { up_to: number | 'inf'; unit_amount_decimal: string }[] {
  const included =
    meter === 'ai_call_minute' ? plan.included.ai_call_minutes : plan.included.sms_segments;
  const overage = plan.overage_cents[meter];
  if (included === 0) {
    return [{ up_to: 'inf', unit_amount_decimal: String(overage) }];
  }
  return [
    { up_to: included, unit_amount_decimal: '0' },
    { up_to: 'inf', unit_amount_decimal: String(overage) },
  ];
}

export function meterUnits(kind: UsageKind, quantity: number): { meter: Meter; value: number } | null {
  switch (kind) {
    case 'sms_segment':
      return { meter: 'sms_segment', value: Math.ceil(quantity) };
    case 'mms':
      return { meter: 'sms_segment', value: 3 * Math.ceil(quantity) };
    case 'ai_call_minute':
      return { meter: 'ai_call_minute', value: Math.ceil(quantity) };
    default:
      return null;
  }
}

export function invoiceAmountCents(
  kind: UsageKind,
  quantity: number,
  unitCostCents: number,
  config: BillingConfig,
): number {
  switch (kind) {
    case 'exact_report':
      return Math.round((quantity * unitCostCents * (100 + config.exact_report_markup_pct)) / 100);
    case 'texting_registration_fee':
    case 'phone_number_month':
      return Math.round(quantity * unitCostCents);
    default:
      throw new RangeError(`${kind} is metered, not invoiced`);
  }
}

// ---------------------------------------------------------------------------
// Config loading and views (bottom half)
// ---------------------------------------------------------------------------

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

const amount = z.number().int().nonnegative();

const planSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9]{1,30}$/, 'Plan key must be lowercase letters and digits'),
    name: z.string().min(1),
    monthly_price_cents: amount,
    included: z
      .object({
        ai_call_minutes: amount,
        sms_segments: amount,
      })
      .strict(),
    overage_cents: z
      .object({
        ai_call_minute: amount,
        sms_segment: amount,
      })
      .strict(),
  })
  .strict();

const billingConfigSchema = z
  .object({
    _note: z.string().optional(),
    plans: z.array(planSchema).min(1),
    exact_report_markup_pct: z.number().min(0).max(500),
    pass_through_cents: z
      .object({
        brand_registration: amount,
        campaign_vetting: amount,
        campaign_monthly: amount,
        phone_number_monthly: amount,
      })
      .strict(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    data.plans.forEach((plan, i) => {
      if (seen.has(plan.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['plans', i, 'key'],
          message: `Duplicate plan key "${plan.key}"`,
          input: plan.key,
        });
      }
      seen.add(plan.key);
    });
  });

export function parseBillingConfig(json: unknown): BillingConfig {
  const parsed = billingConfigSchema.safeParse(json);
  if (!parsed.success) {
    const lines = parsed.error.issues.flatMap((i) =>
      i.code === 'unrecognized_keys'
        ? i.keys.map((k) => `${[...i.path, k].join('.')}: Unrecognized key`)
        : [`${i.path.join('.')}: ${i.message}`],
    );
    throw new BillingConfigError(lines.join('\n'));
  }
  const { _note, ...config } = parsed.data;
  void _note;
  return config as BillingConfig;
}

export function planByKey(config: BillingConfig, key: string): PlanConfig | null {
  return config.plans.find((p) => p.key === key) ?? null;
}

export type PlanSummary = {
  key: string;
  name: string;
  monthlyPriceCents: number;
  included: { aiCallMinutes: number; smsSegments: number };
  overageCents: { aiCallMinute: number; smsSegment: number };
};

export type BillingView = {
  status: CompanyStatus;
  planKey: string | null;
  planName: string | null;
  trialEndsAt: string | null;
  hasPaymentMethod: boolean;
  canOpenPortal: boolean;
  periodStart: string;
  usage: { meter: Meter; used: number; included: number | null }[];
  plans: PlanSummary[];
};
