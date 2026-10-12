import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { dbAudit, Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { signedStripe } from './stripe-helpers.ts';
import { addSmsCustomers, approvedBatch, DAYTIME, rowFor, stepMessages } from './sms-helpers.ts';
import { dbSteps } from './task-helpers.ts';

/** Stripe's webhooks at POST /hooks/stripe (spec 5.2), signed with the test secret. */

const BILLING = 'Texting is paused until billing is sorted out.';
const BAD_SIGNATURE = { error: 'Signature check failed.' };
const NOT_SET_UP = { error: "Billing isn't set up yet." };

type CompanyRow = {
  status: string;
  plan_key: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: Date | null;
  past_due_at: Date | null;
};

let t: TestApp;
let actors: Actors;
let eventSeq = 0;

const acmeId = () => t.seed.a.companyId;

/** Acme is the company Stripe knows as cus_A (set straight in the database, the way the app does it). */
async function linkAcme(): Promise<void> {
  await t.deps.pools.system.$client.query('update companies set stripe_customer_id = $1 where id = $2', ['cus_A', acmeId()]);
}

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(DAYTIME);
  actors = new Actors(t);
  await linkAcme();
});

/** A Stripe event with a fresh id. `created` is in unix seconds and defaults to the test clock's now. */
function stripeEvent(type: string, object: Record<string, unknown>, created?: number): Record<string, unknown> {
  eventSeq += 1;
  return {
    id: `evt_test_${eventSeq}`,
    object: 'event',
    type,
    created: created ?? Math.floor(t.clock.now().getTime() / 1000),
    data: { object },
  };
}

/** Posts an event the way Stripe does: signed at the test clock's time unless told otherwise. */
function post(event: object, o: { secret?: string; at?: Date } = {}) {
  const { body, header } = signedStripe(event, { secret: o.secret, at: o.at ?? t.clock.now() });
  return request(t.app).post('/hooks/stripe').set('Stripe-Signature', header).set('Content-Type', 'application/json').send(body);
}

async function company(): Promise<CompanyRow> {
  const { rows } = await t.deps.pools.system.$client.query<CompanyRow>(
    'select status, plan_key, stripe_subscription_id, trial_ends_at, past_due_at from companies where id = $1',
    [acmeId()],
  );
  return rows[0]!;
}

const auditCount = async () => (await dbAudit(t, acmeId(), 'billing.status_changed')).length;

async function webhookCount(): Promise<number> {
  const { rows } = await t.deps.pools.system.$client.query<{ n: number }>('select count(*)::int as n from webhook_events');
  return rows[0]!.n;
}

const activeSub = (extra: Record<string, unknown> = {}) => ({ id: 'sub_1', customer: 'cus_A', status: 'active', ...extra });

describe('Stripe webhooks', () => {
  test('a bad or old signature is refused', async () => {
    const before = await company();

    const wrongSecret = await post(stripeEvent('customer.subscription.created', activeSub()), { secret: 'whsec_other' });
    expect(wrongSecret.status).toBe(400);
    expect(wrongSecret.body).toEqual(BAD_SIGNATURE);

    const tooOld = await post(stripeEvent('customer.subscription.created', activeSub()), {
      at: new Date(t.clock.now().getTime() - 301_000),
    });
    expect(tooOld.status).toBe(400);
    expect(tooOld.body).toEqual(BAD_SIGNATURE);

    expect(await company()).toEqual(before);
    expect(await webhookCount()).toBe(0);
  });

  test('trial → plan and card → active, with the trial end kept', async () => {
    const before = await company();
    expect(before.status).toBe('trial');
    expect(before.trial_ends_at).not.toBeNull();

    const res = await post(
      stripeEvent('customer.subscription.created', {
        id: 'sub_1',
        customer: 'cus_A',
        status: 'trialing',
        metadata: { plan_key: 'starter' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    expect(await company()).toMatchObject({
      status: 'active',
      plan_key: 'starter',
      stripe_subscription_id: 'sub_1',
      trial_ends_at: before.trial_ends_at,
    });
    const audit = await dbAudit(t, acmeId(), 'billing.status_changed');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.after).toEqual({ from: 'trial', to: 'active', event: 'customer.subscription.created' });
  });

  test('a failed payment makes the company past due and the gate blocks texts', async () => {
    const res = await post(stripeEvent('invoice.payment_failed', { id: 'in_1', customer: 'cus_A' }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    const pastDue = await company();
    expect(pastDue.status).toBe('past_due');
    expect(pastDue.past_due_at).not.toBeNull();

    // Acme's registration is approved (the seed does that), so only the billing rule can stop this text.
    const [nina] = await addSmsCustomers(t, 'a', [{ firstName: 'Nina', phone: '+14025550101', consent: 'attested' }]);
    const { taskId, stepId } = await approvedBatch(t, actors, [nina!]);
    await t.queue.drain(t.deps);

    const step = (await dbSteps(t, 'a', taskId))[0]!;
    expect(step.result).toMatchObject({ blocked: { billing: 1 } });
    expect(rowFor(await stepMessages(t, 'a', stepId), nina!)).toMatchObject({
      status: 'blocked',
      blockRule: 'billing',
      blockReason: BILLING,
    });
    expect(t.sms.sent).toEqual([]);
  });

  test('a paid invoice clears past due, but never revives a canceled company', async () => {
    await post(stripeEvent('invoice.payment_failed', { id: 'in_1', customer: 'cus_A' }));
    expect((await company()).status).toBe('past_due');

    const paid = await post(stripeEvent('invoice.paid', { id: 'in_2', customer: 'cus_A' }));
    expect(paid.status).toBe(200);
    expect(await company()).toMatchObject({ status: 'active', past_due_at: null });

    const deleted = await post(stripeEvent('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_A', status: 'canceled' }));
    expect(deleted.status).toBe(200);
    expect((await company()).status).toBe('canceled');

    const later = await post(stripeEvent('invoice.paid', { id: 'in_3', customer: 'cus_A' }));
    expect(later.status).toBe(200);
    expect(await company()).toMatchObject({ status: 'canceled' });
  });

  test('a deleted subscription cancels', async () => {
    await post(stripeEvent('customer.subscription.created', activeSub({ metadata: { plan_key: 'starter' } })));
    expect((await company()).status).toBe('active');

    const res = await post(stripeEvent('customer.subscription.deleted', { id: 'sub_1', customer: 'cus_A', status: 'canceled' }));
    expect(res.status).toBe(200);
    expect(await company()).toMatchObject({ status: 'canceled', stripe_subscription_id: 'sub_1' });
  });

  test('the same event twice does nothing the second time', async () => {
    const event = stripeEvent('customer.subscription.created', activeSub());

    const first = await post(event);
    const second = await post(event);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ received: true });

    expect(await auditCount()).toBe(1);
    expect(await webhookCount()).toBe(1);
  });

  test('an older event after a newer one is ignored', async () => {
    const nowSec = Math.floor(t.clock.now().getTime() / 1000);
    const sub = { id: 'sub_1', customer: 'cus_A' };

    const newer = await post(stripeEvent('customer.subscription.updated', { ...sub, status: 'past_due' }, nowSec + 200));
    expect(newer.status).toBe(200);
    expect((await company()).status).toBe('past_due');

    const older = await post(stripeEvent('customer.subscription.updated', { ...sub, status: 'active' }, nowSec + 100));
    expect(older.status).toBe(200);
    expect((await company()).status).toBe('past_due');
    expect(await auditCount()).toBe(1);
  });

  test('an unknown customer or event type is acknowledged and ignored', async () => {
    const before = await company();

    const unknown = await post(stripeEvent('invoice.payment_failed', { id: 'in_9', customer: 'cus_UNKNOWN' }));
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ received: true });

    const unrelated = await post(stripeEvent('charge.succeeded', { id: 'ch_1', customer: 'cus_A' }));
    expect(unrelated.status).toBe(200);
    expect(unrelated.body).toEqual({ received: true });

    expect(await company()).toEqual(before);
    expect(await auditCount()).toBe(0);
  });

  test('no webhook secret means not set up', async () => {
    t = await makeTestApp({ STRIPE_WEBHOOK_SECRET: undefined });
    await linkAcme();
    const before = await company();

    const res = await post(stripeEvent('invoice.payment_failed', { id: 'in_1', customer: 'cus_A' }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual(NOT_SET_UP);

    expect(await webhookCount()).toBe(0);
    expect(await company()).toEqual(before);
  });
});
