import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { billingUpdateFor, companyStatusFor } from '../src/billing/stripe-events.ts';
import { StripeSignatureError, verifyStripeSignature } from '../src/billing/stripe-signature.ts';

const SECRET = 'whsec_test_roofline';
const NOW = new Date('2026-10-11T12:00:00Z');
const NOW_SEC = Math.floor(NOW.getTime() / 1000);

function sign(body: string, t: number, secret = SECRET): string {
  return createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

function eventBody(event: object): string {
  return JSON.stringify(event);
}

function eventObj(type: string, object: Record<string, unknown>) {
  return { id: 'evt_1', type, created: 1_800_000_000, data: { object } };
}

describe('companyStatusFor', () => {
  it.each([
    ['trialing', 'active'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'past_due'],
    ['canceled', 'canceled'],
    ['incomplete_expired', 'canceled'],
  ])('maps %s to %s', (status, expected) => {
    expect(companyStatusFor(status)).toBe(expected);
  });

  it.each(['incomplete', 'paused'])('maps %s to null', (status) => {
    expect(companyStatusFor(status)).toBeNull();
  });
});

describe('billingUpdateFor', () => {
  it('maps subscription created with trialing status, plan key and period start', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_A',
        status: 'trialing',
        metadata: { plan_key: 'starter' },
        current_period_start: 1_800_000_500,
      }),
    );
    expect(update).toEqual({
      customerId: 'cus_A',
      eventId: 'evt_1',
      eventCreated: new Date(1_800_000_000 * 1000),
      set: {
        status: 'active',
        stripeSubscriptionId: 'sub_1',
        planKey: 'starter',
        billingPeriodStart: new Date(1_800_000_500 * 1000),
      },
    });
  });

  it('maps subscription updated and omits status when the subscription status is unmapped', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_2',
        customer: 'cus_B',
        status: 'incomplete',
      }),
    );
    expect(update?.customerId).toBe('cus_B');
    expect(update?.set).toEqual({ stripeSubscriptionId: 'sub_2' });
    expect(update?.set).not.toHaveProperty('status');
    expect(update?.set).not.toHaveProperty('planKey');
    expect(update?.set).not.toHaveProperty('billingPeriodStart');
    expect(update).not.toHaveProperty('onlyIfPastDue');
  });

  it('maps subscription updated past_due', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', { id: 'sub_3', customer: 'cus_C', status: 'past_due' }),
    );
    expect(update?.set.status).toBe('past_due');
  });

  it('maps subscription deleted to canceled and clears the stored subscription id, only for that subscription', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.deleted', { id: 'sub_4', customer: 'cus_D', status: 'canceled' }),
    );
    expect(update).toEqual({
      customerId: 'cus_D',
      eventId: 'evt_1',
      eventCreated: new Date(1_800_000_000 * 1000),
      set: { status: 'canceled', stripeSubscriptionId: null },
      onlyIfSubscription: 'sub_4',
    });
    expect(update).not.toHaveProperty('onlyIfPastDue');
  });

  it('maps invoice payment_failed to past_due', () => {
    const update = billingUpdateFor(eventObj('invoice.payment_failed', { customer: 'cus_E' }));
    expect(update?.set).toEqual({ status: 'past_due' });
    expect(update).not.toHaveProperty('onlyIfPastDue');
  });

  it('maps invoice paid to active with onlyIfPastDue true', () => {
    const update = billingUpdateFor(eventObj('invoice.paid', { customer: 'cus_F' }));
    expect(update?.set).toEqual({ status: 'active' });
    expect(update?.onlyIfPastDue).toBe(true);
  });

  it('returns null for an unknown event type', () => {
    expect(billingUpdateFor(eventObj('customer.created', { customer: 'cus_G' }))).toBeNull();
  });

  it('returns null when the customer is missing', () => {
    expect(billingUpdateFor(eventObj('invoice.paid', {}))).toBeNull();
    expect(billingUpdateFor(eventObj('invoice.paid', { customer: 42 }))).toBeNull();
  });

  it('prefers item-level current_period_start over the top-level one', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_5',
        customer: 'cus_H',
        status: 'active',
        current_period_start: 1_800_000_100,
        items: { data: [{ current_period_start: 1_800_000_900 }] },
      }),
    );
    expect(update?.set.billingPeriodStart).toEqual(new Date(1_800_000_900 * 1000));
  });

  it('falls back to the top-level current_period_start when items have none', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_6',
        customer: 'cus_I',
        current_period_start: 1_800_000_100,
        items: { data: [{}] },
      }),
    );
    expect(update?.set.billingPeriodStart).toEqual(new Date(1_800_000_100 * 1000));
  });

  it('takes planKey from the lookup key when metadata lacks plan_key', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_7',
        customer: 'cus_J',
        status: 'active',
        metadata: {},
        items: { data: [{ price: { lookup_key: 'roofline_pro_monthly' } }] },
      }),
    );
    expect(update?.set.planKey).toBe('pro');
  });

  it('skips foreign lookup keys and uses the first one that maps to a plan', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_8',
        customer: 'cus_K',
        items: {
          data: [
            { price: { lookup_key: 'something_else' } },
            { price: { lookup_key: 'roofline_pro_sms_segment' } },
          ],
        },
      }),
    );
    expect(update?.set.planKey).toBe('pro');
  });

  it('omits planKey when no lookup key maps to a plan', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_9',
        customer: 'cus_L',
        items: { data: [{ price: { lookup_key: 'other' } }] },
      }),
    );
    expect(update?.set).not.toHaveProperty('planKey');
  });

  it('metadata.plan_key wins over the lookup key', () => {
    const update = billingUpdateFor(
      eventObj('customer.subscription.updated', {
        id: 'sub_10',
        customer: 'cus_M',
        metadata: { plan_key: 'starter' },
        items: { data: [{ price: { lookup_key: 'roofline_pro_monthly' } }] },
      }),
    );
    expect(update?.set.planKey).toBe('starter');
  });
});

describe('verifyStripeSignature', () => {
  const body = eventBody({
    id: 'evt_sig',
    type: 'invoice.paid',
    created: NOW_SEC,
    data: { object: { customer: 'cus_S' } },
  });
  const raw = Buffer.from(body, 'utf8');

  it('returns the event for a good signature', () => {
    const header = `t=${NOW_SEC},v1=${sign(body, NOW_SEC)}`;
    const event = verifyStripeSignature(raw, header, SECRET, NOW);
    expect(event).toEqual({
      id: 'evt_sig',
      type: 'invoice.paid',
      created: NOW_SEC,
      data: { object: { customer: 'cus_S' } },
    });
  });

  it('refuses a wrong secret', () => {
    const header = `t=${NOW_SEC},v1=${sign(body, NOW_SEC, 'whsec_other')}`;
    expect(() => verifyStripeSignature(raw, header, SECRET, NOW)).toThrow(StripeSignatureError);
  });

  it('refuses a signature 301 seconds old', () => {
    const t = NOW_SEC - 301;
    const header = `t=${t},v1=${sign(body, t)}`;
    expect(() => verifyStripeSignature(raw, header, SECRET, NOW)).toThrow(StripeSignatureError);
  });

  it('accepts when the second v1 is the correct one', () => {
    const header = `t=${NOW_SEC},v1=${'0'.repeat(64)},v1=${sign(body, NOW_SEC)}`;
    const event = verifyStripeSignature(raw, header, SECRET, NOW);
    expect(event.id).toBe('evt_sig');
  });

  it('refuses a missing header', () => {
    expect(() => verifyStripeSignature(raw, undefined, SECRET, NOW)).toThrow(StripeSignatureError);
  });

  it('refuses a header with no v1', () => {
    expect(() => verifyStripeSignature(raw, `t=${NOW_SEC}`, SECRET, NOW)).toThrow(
      StripeSignatureError,
    );
  });

  it('refuses a body that is not valid JSON', () => {
    const bad = 'not json';
    const header = `t=${NOW_SEC},v1=${sign(bad, NOW_SEC)}`;
    expect(() => verifyStripeSignature(Buffer.from(bad), header, SECRET, NOW)).toThrow(
      StripeSignatureError,
    );
  });
});
