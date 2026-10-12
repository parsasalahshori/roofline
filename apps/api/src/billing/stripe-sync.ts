import Stripe from 'stripe';
import {
  type BillingConfig,
  METER_EVENT_NAME,
  METERS,
  type Meter,
  meteredTiers,
  priceLookupKeys,
} from '@roofline/shared';
import { stripeFailure } from '../providers/stripe.ts';

/*
 * Makes Stripe match the plan config: the meters, one product per plan and the three prices per
 * plan. `planStripeSync` is pure (it only compares); `applySyncAction` makes one change. Old prices
 * are never archived, because live subscriptions still use them.
 */

/** What Stripe has now, as far as the plan sync cares. Only roofline_ prices and roofline_plan products are read. */
export type StripeState = {
  meters: { id: string; eventName: string }[];
  products: { id: string; planKey: string; name: string }[];
  prices: {
    id: string;
    lookupKey: string;
    unitAmount: number | null;
    tiers: { up_to: number | null; unit_amount_decimal: string }[] | null;
    meterId: string | null;
  }[];
};

export type SyncAction =
  | { kind: 'create_meter'; meter: Meter }
  | { kind: 'create_product' | 'rename_product'; planKey: string; name: string }
  | { kind: 'create_price'; lookupKey: string; planKey: string; spec: Record<string, unknown> };

const MISSING_PRODUCT = 'A Stripe product is missing; run sync:stripe-plans.';

const METER_DISPLAY_NAME: Record<Meter, string> = {
  ai_call_minute: 'AI call minutes',
  sms_segment: 'Text segments',
};

/** The actions that make Stripe match `config`, in order: meters, then products, then prices. */
export function planStripeSync(config: BillingConfig, state: StripeState): SyncAction[] {
  const actions: SyncAction[] = [];

  for (const meter of METERS) {
    const eventName = METER_EVENT_NAME[meter];
    if (!state.meters.some((m) => m.eventName === eventName)) actions.push({ kind: 'create_meter', meter });
  }

  for (const plan of config.plans) {
    const product = state.products.find((p) => p.planKey === plan.key);
    if (!product) actions.push({ kind: 'create_product', planKey: plan.key, name: plan.name });
    else if (product.name !== plan.name) actions.push({ kind: 'rename_product', planKey: plan.key, name: plan.name });
  }

  for (const plan of config.plans) {
    const keys = priceLookupKeys(plan.key);
    const monthly = state.prices.find((p) => p.lookupKey === keys.monthly);
    if (!monthly || monthly.unitAmount !== plan.monthly_price_cents) {
      actions.push({
        kind: 'create_price',
        lookupKey: keys.monthly,
        planKey: plan.key,
        spec: {
          currency: 'usd',
          unit_amount: plan.monthly_price_cents,
          recurring: { interval: 'month' },
          lookup_key: keys.monthly,
          transfer_lookup_key: true,
        },
      });
    }

    for (const meter of METERS) {
      const lookupKey = keys[meter];
      const tiers = meteredTiers(plan, meter);
      const existing = state.prices.find((p) => p.lookupKey === lookupKey);
      if (existing && !tiersDiffer(existing.tiers, tiers)) continue;
      const eventName = METER_EVENT_NAME[meter];
      const meterId = state.meters.find((m) => m.eventName === eventName)?.id ?? eventName;
      actions.push({
        kind: 'create_price',
        lookupKey,
        planKey: plan.key,
        spec: {
          currency: 'usd',
          billing_scheme: 'tiered',
          tiers_mode: 'graduated',
          tiers,
          recurring: { interval: 'month', usage_type: 'metered', meter: meterId },
          lookup_key: lookupKey,
          transfer_lookup_key: true,
        },
      });
    }
  }

  return actions;
}

/** True when the tiers in Stripe are not the wanted tiers. Stripe's null up_to is the same as 'inf'; amounts compare as numbers. */
function tiersDiffer(
  have: StripeState['prices'][number]['tiers'],
  want: { up_to: number | 'inf'; unit_amount_decimal: string }[],
): boolean {
  if (have === null || have.length !== want.length) return true;
  return want.some((w, i) => {
    const h = have[i]!;
    const haveUpTo = h.up_to ?? 'inf';
    return haveUpTo !== w.up_to || Number(h.unit_amount_decimal) !== Number(w.unit_amount_decimal);
  });
}

/** The plain line for an action: what the script prints, whether it is applied or only planned. */
export function describeAction(action: SyncAction): string {
  switch (action.kind) {
    case 'create_meter':
      return `Create meter ${METER_EVENT_NAME[action.meter]}`;
    case 'create_product':
      return `Create product ${action.planKey}`;
    case 'rename_product':
      return `Rename product ${action.planKey}`;
    case 'create_price':
      return `Create price ${action.lookupKey}`;
  }
}

/** Reads the active meters, the roofline products and the roofline prices (with their tiers) from Stripe. */
export async function readStripeState(stripe: Stripe): Promise<StripeState> {
  return mapStripeFailure(async () => {
    const meters: StripeState['meters'] = [];
    for await (const m of stripe.billing.meters.list({ status: 'active', limit: 100 })) {
      meters.push({ id: m.id, eventName: m.event_name });
    }

    const products: StripeState['products'] = [];
    for await (const p of stripe.products.list({ active: true, limit: 100 })) {
      const planKey = p.metadata?.roofline_plan;
      if (planKey) products.push({ id: p.id, planKey, name: p.name });
    }

    const prices: StripeState['prices'] = [];
    for await (const p of stripe.prices.list({ active: true, limit: 100, expand: ['data.tiers'] })) {
      if (!p.lookup_key?.startsWith('roofline_')) continue;
      prices.push({
        id: p.id,
        lookupKey: p.lookup_key,
        unitAmount: p.unit_amount,
        tiers: p.tiers?.map((t) => ({ up_to: t.up_to, unit_amount_decimal: String(t.unit_amount_decimal ?? '') })) ?? null,
        meterId: p.recurring?.meter ?? null,
      });
    }

    return { meters, products, prices };
  });
}

/**
 * Makes one change in Stripe and returns the plain line for it. `state` is updated with what was
 * created, so a later price in the same run can find a product or meter made earlier in the run.
 */
export async function applySyncAction(stripe: Stripe, action: SyncAction, state: StripeState): Promise<string> {
  return mapStripeFailure(async () => {
    switch (action.kind) {
      case 'create_meter': {
        const eventName = METER_EVENT_NAME[action.meter];
        const meter = await stripe.billing.meters.create({
          display_name: METER_DISPLAY_NAME[action.meter],
          event_name: eventName,
          default_aggregation: { formula: 'sum' },
          customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
          value_settings: { event_payload_key: 'value' },
        });
        state.meters.push({ id: meter.id, eventName });
        break;
      }
      case 'create_product': {
        const product = await stripe.products.create({
          name: action.name,
          metadata: { roofline_plan: action.planKey },
        });
        state.products.push({ id: product.id, planKey: action.planKey, name: action.name });
        break;
      }
      case 'rename_product': {
        const product = state.products.find((p) => p.planKey === action.planKey);
        if (!product) throw new Error(MISSING_PRODUCT);
        await stripe.products.update(product.id, { name: action.name });
        product.name = action.name;
        break;
      }
      case 'create_price': {
        const product = state.products.find((p) => p.planKey === action.planKey);
        if (!product) throw new Error(MISSING_PRODUCT);
        const spec = { ...action.spec };
        const recurring = spec.recurring as { meter?: unknown } | undefined;
        let meterId: string | null = null;
        if (recurring && typeof recurring.meter === 'string') {
          const meter = state.meters.find((m) => m.eventName === recurring.meter);
          if (meter) {
            meterId = meter.id;
            spec.recurring = { ...recurring, meter: meter.id };
          } else {
            meterId = recurring.meter;
          }
        }
        const price = await stripe.prices.create({ ...spec, product: product.id } as unknown as Stripe.PriceCreateParams);
        state.prices.push({
          id: price.id,
          lookupKey: action.lookupKey,
          unitAmount: typeof spec.unit_amount === 'number' ? spec.unit_amount : null,
          tiers: Array.isArray(spec.tiers) ? stateTiers(spec.tiers as { up_to: number | 'inf'; unit_amount_decimal: string }[]) : null,
          meterId,
        });
        break;
      }
    }
    return describeAction(action);
  });
}

function stateTiers(tiers: { up_to: number | 'inf'; unit_amount_decimal: string }[]): StripeState['prices'][number]['tiers'] {
  return tiers.map((t) => ({ up_to: t.up_to === 'inf' ? null : t.up_to, unit_amount_decimal: t.unit_amount_decimal }));
}

/** Runs `work`; a Stripe failure is mapped by `stripeFailure`, so the Stripe error and its message are dropped. */
async function mapStripeFailure<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw stripeFailure(err);
  }
}
