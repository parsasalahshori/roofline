import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import {
  type BillingConfig,
  METERS,
  METER_EVENT_NAME,
  type Meter,
  meteredTiers,
  parseBillingConfig,
  priceLookupKeys,
} from '@roofline/shared';
import { planStripeSync, type StripeState, type SyncAction } from '../src/billing/stripe-sync.ts';

const EXAMPLE_PATH = fileURLToPath(new URL('../../../config/billing-plans.example.json', import.meta.url));

function exampleConfig(): BillingConfig {
  return parseBillingConfig(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')));
}

const METER_IDS: Record<Meter, string> = { ai_call_minute: 'mtr_ai', sms_segment: 'mtr_sms' };

/** A Stripe state that matches the config exactly: meters, one product per plan, three prices per plan. */
function matchingState(config: BillingConfig): StripeState {
  const meters = METERS.map((m) => ({ id: METER_IDS[m], eventName: METER_EVENT_NAME[m] }));
  const products = config.plans.map((plan) => ({ id: 'prod_' + plan.key, planKey: plan.key, name: plan.name }));
  const prices: StripeState['prices'] = [];
  for (const plan of config.plans) {
    const keys = priceLookupKeys(plan.key);
    prices.push({
      id: 'price_' + keys.monthly,
      lookupKey: keys.monthly,
      unitAmount: plan.monthly_price_cents,
      tiers: null,
      meterId: null,
    });
    for (const m of METERS) {
      prices.push({
        id: 'price_' + keys[m],
        lookupKey: keys[m],
        unitAmount: null,
        tiers: meteredTiers(plan, m).map((t) => ({
          up_to: t.up_to === 'inf' ? null : t.up_to,
          unit_amount_decimal: t.unit_amount_decimal,
        })),
        meterId: METER_IDS[m],
      });
    }
  }
  return { meters, products, prices };
}

function emptyState(): StripeState {
  return { meters: [], products: [], prices: [] };
}

function countKinds(actions: SyncAction[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const action of actions) counts[action.kind] = (counts[action.kind] ?? 0) + 1;
  return counts;
}

describe('planStripeSync', () => {
  test('empty state needs 2 meters, 2 products and 6 prices for the example config', () => {
    const config = exampleConfig();
    expect(config.plans).toHaveLength(2);

    const actions = planStripeSync(config, emptyState());
    expect(countKinds(actions)).toEqual({ create_meter: 2, create_product: 2, create_price: 6 });
  });

  test('a state matching the example config needs nothing', () => {
    const config = exampleConfig();
    expect(planStripeSync(config, matchingState(config))).toEqual([]);
  });

  test('a changed sms overage creates only the sms price, with lookup key transfer', () => {
    const original = exampleConfig();
    const starter = original.plans.find((p) => p.key === 'starter');
    expect(starter?.overage_cents.sms_segment).toBe(3);

    const changed = structuredClone(original);
    changed.plans.find((p) => p.key === 'starter')!.overage_cents.sms_segment = 4;

    const actions = planStripeSync(changed, matchingState(original));
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action.kind).toBe('create_price');
    if (action.kind !== 'create_price') throw new Error('expected create_price');
    expect(action.lookupKey).toBe('roofline_starter_sms_segment');
    expect(action.spec.transfer_lookup_key).toBe(true);
  });

  test('a renamed product gives exactly one rename_product for that plan', () => {
    const config = exampleConfig();
    const state = matchingState(config);
    const starterProduct = state.products.find((p) => p.planKey === 'starter');
    expect(starterProduct).toBeDefined();
    starterProduct!.name = 'Old name';

    const actions = planStripeSync(config, state);
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action.kind).toBe('rename_product');
    if (action.kind !== 'rename_product') throw new Error('expected rename_product');
    expect(action.planKey).toBe('starter');
    expect(action.name).toBe('Starter');
  });
});
