import { beforeEach, describe, expect, test } from 'vitest';
import { recordUsage, withTenant } from '@roofline/db';
import { createApp } from '../src/app.ts';
import { UnconfiguredBillingProvider } from '../src/providers/billing.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const APP_ORIGIN = 'https://app.roofline.test';

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const VERIFY_FIRST = 'Please confirm your email first. We sent you a link.';
const UNKNOWN_PLAN = 'Pick one of the plans.';
const ALREADY_SUBSCRIBED = 'You already have a plan. Use Change plan.';
const ADD_CARD_FIRST = 'Add a card first.';
const PICK_PLAN_FIRST = 'Pick a plan first.';
const NOT_SET_UP = "Billing isn't set up yet.";
const CANT_REACH = "We couldn't reach the payment service. Try again in a minute.";

const EXAMPLE_PLANS = [
  {
    key: 'starter',
    name: 'Starter',
    monthlyPriceCents: 19900,
    included: { aiCallMinutes: 300, smsSegments: 1000 },
    overageCents: { aiCallMinute: 25, smsSegment: 3 },
  },
  {
    key: 'pro',
    name: 'Pro',
    monthlyPriceCents: 39900,
    included: { aiCallMinutes: 1000, smsSegments: 5000 },
    overageCents: { aiCallMinute: 20, smsSegment: 2 },
  },
];

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
});

/** A look at (or change to) the global tables through the system pool's raw client. */
async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await t.deps.pools.system.$client.query(text, params);
  return result.rows as T[];
}

/** The owner of company A, signed in. */
function ownerCtx() {
  return { companyId: t.seed.a.companyId, userId: t.seed.a.owner.userId, role: 'owner' as const, canApproveSpend: false };
}

async function setTrialEnd(d: Date | null): Promise<void> {
  await sql('update companies set trial_ends_at = $2 where id = $1', [t.seed.a.companyId, d]);
}

async function setSubscription(id: string | null): Promise<void> {
  await sql('update companies set stripe_subscription_id = $2 where id = $1', [t.seed.a.companyId, id]);
}

async function storedCustomerIds(): Promise<(string | null)[]> {
  const rows = await sql<{ stripe_customer_id: string | null }>(
    'select stripe_customer_id from companies where id = $1',
    [t.seed.a.companyId],
  );
  return rows.map((r) => r.stripe_customer_id);
}

async function owner(): Promise<SuperAgent> {
  return loginAs(t.app, t.seed.a.owner);
}

describe('GET /api/billing', () => {
  test('owner sees the plan, trial and usage', async () => {
    const at = t.clock.now();
    await withTenant(t.deps.pools, ownerCtx(), async (tx) => {
      await recordUsage(tx, ownerCtx(), {
        kind: 'sms_segment',
        quantity: 2,
        unitCostCents: null,
        refType: 'message',
        refId: 'usage-sms-1',
        description: null,
        at,
      });
      await recordUsage(tx, ownerCtx(), {
        kind: 'sms_segment',
        quantity: 1,
        unitCostCents: null,
        refType: 'message',
        refId: 'usage-sms-2',
        description: null,
        at,
      });
      await recordUsage(tx, ownerCtx(), {
        kind: 'mms',
        quantity: 1,
        unitCostCents: null,
        refType: 'message',
        refId: 'usage-mms-1',
        description: null,
        at,
      });
      await recordUsage(tx, ownerCtx(), {
        kind: 'ai_call_minute',
        quantity: 4,
        unitCostCents: null,
        refType: 'call',
        refId: 'usage-call-1',
        description: null,
        at,
      });
    });

    const res = await (await owner()).get('/api/billing');
    expect(res.status).toBe(200);
    expect(res.body.usage).toEqual([
      { meter: 'ai_call_minute', used: 4, included: null },
      { meter: 'sms_segment', used: 6, included: null },
    ]);
    expect(res.body.plans).toEqual(EXAMPLE_PLANS);
    expect(res.body.status).toBe('trial');
    expect(res.body.canOpenPortal).toBe(false);
    expect(res.body.planKey).toBeNull();
    expect(res.body.planName).toBeNull();
    expect(res.body.hasPaymentMethod).toBe(false);
  });

  test("office and reps can't see billing", async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    const rep = await loginAs(t.app, t.seed.a.rep);
    const officeRes = await office.get('/api/billing');
    expect(officeRes.status).toBe(403);
    expect(officeRes.body).toEqual({ error: NOT_ALLOWED });
    const repRes = await rep.get('/api/billing');
    expect(repRes.status).toBe(403);
    expect(repRes.body).toEqual({ error: NOT_ALLOWED });
  });
});

describe('POST /api/billing/checkout', () => {
  test('checkout keeps the trial end', async () => {
    const trialEnd = new Date(t.clock.now().getTime() + 10 * DAY);
    await setTrialEnd(trialEnd);
    const agent = await owner();

    const res = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://checkout.stripe.test/c/cs_fake_1' });

    const [stored] = await sql<{ trial_ends_at: Date }>('select trial_ends_at from companies where id = $1', [
      t.seed.a.companyId,
    ]);
    expect(t.billing.checkouts[0]).toEqual({
      customerId: 'cus_fake_1',
      companyId: t.seed.a.companyId,
      planKey: 'starter',
      priceLookupKeys: ['roofline_starter_monthly', 'roofline_starter_ai_call_minute', 'roofline_starter_sms_segment'],
      trialEnd: stored!.trial_ends_at,
      successUrl: `${APP_ORIGIN}/settings/billing?checkout=done`,
      cancelUrl: `${APP_ORIGIN}/settings/billing`,
    });
    expect(t.billing.checkouts[0]!.trialEnd).toEqual(trialEnd);
    expect(await storedCustomerIds()).toEqual(['cus_fake_1']);
  });

  test('a trial ending within 48 hours bills at checkout', async () => {
    await setTrialEnd(new Date(t.clock.now().getTime() + 24 * 60 * 60 * 1000));
    const agent = await owner();

    const res = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(res.status).toBe(200);
    expect(t.billing.checkouts[0]!.trialEnd).toBeNull();
  });

  test('two checkouts at once make one customer', async () => {
    const first = await owner();
    const second = await owner();

    const [a, b] = await Promise.all([
      first.post('/api/billing/checkout').send({ planKey: 'starter' }),
      second.post('/api/billing/checkout').send({ planKey: 'pro' }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const stored = await storedCustomerIds();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toBeNull();
    expect(new Set(t.billing.checkouts.map((c) => c.customerId)).size).toBe(1);
  });

  test('unknown plan, already subscribed, unconfirmed email', async () => {
    const agent = await owner();

    const unknown = await agent.post('/api/billing/checkout').send({ planKey: 'nope' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: UNKNOWN_PLAN, field: 'planKey' });
    expect(t.billing.checkouts).toHaveLength(0);

    await setSubscription('sub_1');
    const subscribed = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(subscribed.status).toBe(409);
    expect(subscribed.body).toEqual({ error: ALREADY_SUBSCRIBED });
    await setSubscription(null);

    await sql('update users set email_verified_at = null where id = $1', [t.seed.a.owner.userId]);
    const unverified = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(unverified.status).toBe(403);
    expect(unverified.body).toEqual({ error: VERIFY_FIRST });
    expect(t.billing.checkouts).toHaveLength(0);
  });

  test("billing that isn't set up says so", async () => {
    const agent = await owner();

    const unconfigured = createApp({ ...t.deps, billing: new UnconfiguredBillingProvider() });
    const unset = await loginAs(unconfigured, t.seed.a.owner);
    const notSetUp = await unset.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(notSetUp.status).toBe(503);
    expect(notSetUp.body).toEqual({ error: NOT_SET_UP });

    t.billing.failNext(1);
    const unreachable = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(unreachable.status).toBe(503);
    expect(unreachable.body).toEqual({ error: CANT_REACH });
    expect(t.billing.checkouts).toHaveLength(0);
  });
});

describe('POST /api/billing/portal', () => {
  test('portal needs a customer', async () => {
    const agent = await owner();

    const none = await agent.post('/api/billing/portal').send({});
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: ADD_CARD_FIRST });

    const checkout = await agent.post('/api/billing/checkout').send({ planKey: 'starter' });
    expect(checkout.status).toBe(200);

    const portal = await agent.post('/api/billing/portal').send({});
    expect(portal.status).toBe(200);
    expect(portal.body).toEqual({ url: 'https://billing.stripe.test/p/bps_fake_1' });
    expect(t.billing.portals[0]).toEqual({
      customerId: 'cus_fake_1',
      returnUrl: `${APP_ORIGIN}/settings/billing`,
    });
  });
});

describe('POST /api/billing/plan', () => {
  test('change plan asks the provider', async () => {
    const agent = await owner();

    const none = await agent.post('/api/billing/plan').send({ planKey: 'pro' });
    expect(none.status).toBe(409);
    expect(none.body).toEqual({ error: PICK_PLAN_FIRST });
    expect(t.billing.planChanges).toHaveLength(0);

    await setSubscription('sub_1');
    const res = await agent.post('/api/billing/plan').send({ planKey: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(t.billing.planChanges[0]!.planKey).toBe('pro');
    expect(t.billing.planChanges[0]!.subscriptionId).toBe('sub_1');
    expect(t.billing.planChanges[0]!.priceLookupKeys).toEqual([
      'roofline_pro_monthly',
      'roofline_pro_ai_call_minute',
      'roofline_pro_sms_segment',
    ]);
  });
});
