import { asc, isNull } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, inject, test } from 'vitest';
import { recordUsage, openMeterBatches, usageEvents, withTenant } from '@roofline/db';
import { METER_EVENT_NAME } from '@roofline/shared';
import { reportUsage } from '../src/jobs/scheduler/report-usage.ts';
import { systemContext } from '../src/permissions.ts';
import { inCompany } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The usage reporter (spec 5.2): metered usage goes to Stripe as one meter event per meter and
 * batch; invoiced usage goes as one invoice item per row. Every send is idempotent (the batch id
 * and `usage:<row id>` are the provider's dedupe keys), so a resend after a crash changes nothing.
 */

const NOW = new Date('2026-10-15T14:00:00.000Z');
const MINUTE = 60 * 1000;
const EXACT = 'Exact roof report — 812 Oak St';
const REGISTRATION = 'Texting registration: business check';
const NUMBER = 'Texting number (402) 555-0100 — October 2026';

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
});

const idOf = (company: 'a' | 'b') => t.seed[company].companyId;

/** Sets a company's Stripe customer, subscription and status straight in the table, as the owner. */
async function setBilling(companyId: string, customerId: string | null, subscriptionId: string | null, status: string): Promise<void> {
  const owner = new pg.Client({ connectionString: inject('dbUrls').owner });
  await owner.connect();
  try {
    await owner.query('update companies set stripe_customer_id = $1, stripe_subscription_id = $2, status = $3 where id = $4', [
      customerId,
      subscriptionId,
      status,
      companyId,
    ]);
  } finally {
    await owner.end();
  }
}

/** A company with a Stripe customer and a live subscription (or neither, when the customer is null). */
async function setCustomer(companyId: string, customerId: string | null): Promise<void> {
  if (customerId === null) await setBilling(companyId, null, null, 'active');
  else await setBilling(companyId, customerId, customerId.replace('cus_', 'sub_'), 'active');
}

type Row = {
  kind: 'sms_segment' | 'mms' | 'ai_call_minute' | 'exact_report' | 'texting_registration_fee' | 'phone_number_month';
  quantity: number;
  unitCostCents: number | null;
  refId: string;
  description: string | null;
  at?: Date;
};

/** Writes usage rows for a company, each in its own tenant transaction. */
async function addUsage(companyId: string, rows: Row[]): Promise<void> {
  const ctx = systemContext(companyId);
  for (const r of rows) {
    await withTenant(t.deps.pools, ctx, (tx) =>
      recordUsage(tx, ctx, {
        kind: r.kind,
        quantity: r.quantity,
        unitCostCents: r.unitCostCents,
        refType: 'test',
        refId: r.refId,
        description: r.description,
        at: r.at ?? NOW,
      }),
    );
  }
}

/** Every usage row of a company, oldest first. */
const usageOf = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(usageEvents).orderBy(asc(usageEvents.at), asc(usageEvents.id)));

/** The rows of a company that are still waiting to be reported. */
const unreportedOf = (companyId: string) =>
  inCompany(t, companyId, (tx) => tx.select().from(usageEvents).where(isNull(usageEvents.reportedToStripeAt)));

describe('report usage', () => {
  test('usage becomes one meter event per meter and invoice items with the right amounts', async () => {
    const a = idOf('a');
    await setCustomer(a, 'cus_fake_1');
    // The invoice rows get distinct times so the invoice items come out in a known order.
    await addUsage(a, [
      { kind: 'sms_segment', quantity: 2, unitCostCents: null, refId: 'sms-1', description: null },
      { kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'sms-2', description: null },
      { kind: 'mms', quantity: 1, unitCostCents: null, refId: 'mms-1', description: null },
      { kind: 'ai_call_minute', quantity: 4, unitCostCents: null, refId: 'ai-1', description: null },
      { kind: 'exact_report', quantity: 1, unitCostCents: 4500, refId: 'report-1', description: EXACT, at: new Date(NOW.getTime() - 3 * MINUTE) },
      { kind: 'texting_registration_fee', quantity: 1, unitCostCents: 4400, refId: 'reg-1', description: REGISTRATION, at: new Date(NOW.getTime() - 2 * MINUTE) },
      { kind: 'phone_number_month', quantity: 1, unitCostCents: 115, refId: 'num-1', description: NUMBER, at: new Date(NOW.getTime() - MINUTE) },
    ]);

    await reportUsage(t.deps, NOW);

    expect([...t.billing.meterEvents].sort((x, y) => x.eventName.localeCompare(y.eventName))).toMatchObject([
      { eventName: 'roofline_ai_call_minute', customerId: 'cus_fake_1', value: 4 },
      { eventName: 'roofline_sms_segment', customerId: 'cus_fake_1', value: 6 },
    ]);

    const rows = await usageOf(a);
    const invoiced = rows.filter((r) => r.kind === 'exact_report' || r.kind === 'texting_registration_fee' || r.kind === 'phone_number_month');
    expect(invoiced.map((r) => r.description)).toEqual([EXACT, REGISTRATION, NUMBER]);
    expect(t.billing.invoiceItems).toHaveLength(3);
    expect(t.billing.invoiceItems).toMatchObject([
      { customerId: 'cus_fake_1', amountCents: 5400, description: EXACT, idempotencyKey: `usage:${invoiced[0]!.id}` },
      { customerId: 'cus_fake_1', amountCents: 4400, description: REGISTRATION, idempotencyKey: `usage:${invoiced[1]!.id}` },
      { customerId: 'cus_fake_1', amountCents: 115, description: NUMBER, idempotencyKey: `usage:${invoiced[2]!.id}` },
    ]);

    expect(rows.every((r) => r.reportedToStripeAt !== null)).toBe(true);
    expect(invoiced.every((r) => r.stripeInvoiceItemId !== null)).toBe(true);
  });

  test('a second run reports nothing new', async () => {
    const a = idOf('a');
    await setCustomer(a, 'cus_fake_1');
    await addUsage(a, [
      { kind: 'sms_segment', quantity: 2, unitCostCents: null, refId: 'sms-1', description: null },
      { kind: 'exact_report', quantity: 1, unitCostCents: 4500, refId: 'report-1', description: EXACT },
    ]);

    await reportUsage(t.deps, NOW);
    const meterCount = t.billing.meterEvents.length;
    const invoiceCount = t.billing.invoiceItems.length;
    const calls = t.billing.calls.length;

    await reportUsage(t.deps, NOW);

    expect(t.billing.meterEvents).toHaveLength(meterCount);
    expect(t.billing.invoiceItems).toHaveLength(invoiceCount);
    expect(t.billing.calls).toHaveLength(calls);
  });

  test('a crash after reporting resends the same batch, which the provider ignores', async () => {
    const a = idOf('a');
    await setCustomer(a, 'cus_fake_1');
    await addUsage(a, [
      { kind: 'sms_segment', quantity: 2, unitCostCents: null, refId: 'sms-1', description: null },
      { kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'sms-2', description: null },
      { kind: 'ai_call_minute', quantity: 4, unitCostCents: null, refId: 'ai-1', description: null },
    ]);

    // The run that crashed: it sent the batches to Stripe, then died before marking them.
    const ctx = systemContext(a);
    const batches = await withTenant(t.deps.pools, ctx, (tx) => openMeterBatches(tx, ctx));
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      await t.billing.reportMeterEvent({
        eventName: METER_EVENT_NAME[batch.meter],
        customerId: 'cus_fake_1',
        value: batch.value,
        identifier: batch.batchId,
        timestamp: NOW,
      });
    }
    expect(t.billing.meterEvents).toHaveLength(2);

    await reportUsage(t.deps, NOW);

    // The resend happened, and the provider kept one event per identifier.
    expect(t.billing.calls.filter((c) => c.method === 'reportMeterEvent')).toHaveLength(4);
    expect(t.billing.meterEvents).toHaveLength(2);
    expect(new Set(t.billing.meterEvents.map((e) => e.identifier)).size).toBe(2);
    expect(await unreportedOf(a)).toHaveLength(0);
  });

  test('companies without a customer are skipped; one failure does not stop the others', async () => {
    const a = idOf('a');
    const b = idOf('b');
    await setCustomer(b, 'cus_fake_2');
    await addUsage(a, [{ kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'a-sms-1', description: null }]);
    await addUsage(b, [{ kind: 'sms_segment', quantity: 2, unitCostCents: null, refId: 'b-sms-1', description: null }]);

    await reportUsage(t.deps, NOW);

    // B is reported; A has no customer yet, so nothing was sent for A and its row waits.
    expect(await unreportedOf(b)).toHaveLength(0);
    expect(await unreportedOf(a)).toHaveLength(1);
    expect(t.billing.meterEvents).toHaveLength(1);
    expect(t.billing.meterEvents.every((e) => e.customerId === 'cus_fake_2')).toBe(true);

    // Now both have customers and fresh usage; the provider fails its first call.
    await setCustomer(a, 'cus_fake_1');
    await addUsage(a, [{ kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'a-sms-2', description: null }]);
    await addUsage(b, [{ kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'b-sms-2', description: null }]);
    const loggedBefore = t.logged.length;
    t.billing.failNext(1);

    await reportUsage(t.deps, NOW);

    // Exactly one company still has rows waiting, and the other one is fully reported.
    const waiting = [await unreportedOf(a), await unreportedOf(b)].map((rows) => rows.length);
    expect(waiting.filter((n) => n > 0)).toHaveLength(1);
    expect(waiting.filter((n) => n === 0)).toHaveLength(1);
    expect(t.logged).toHaveLength(loggedBefore + 1);
    expect(t.logged[loggedBefore]!.where).toMatch(/^report-usage/);
  });

  test('meter usage waits for a subscription; invoice items do not', async () => {
    const a = idOf('a');
    await setBilling(a, 'cus_fake_1', null, 'trial');
    await addUsage(a, [
      { kind: 'sms_segment', quantity: 3, unitCostCents: null, refId: 'sms-1', description: null },
      { kind: 'exact_report', quantity: 1, unitCostCents: 4500, refId: 'report-1', description: EXACT },
    ]);

    await reportUsage(t.deps, NOW);

    expect(t.billing.meterEvents).toEqual([]);
    expect(t.billing.invoiceItems).toHaveLength(1);
    const held = await usageOf(a);
    const sms = held.find((r) => r.kind === 'sms_segment')!;
    const report = held.find((r) => r.kind === 'exact_report')!;
    expect(sms.reportedToStripeAt).toBeNull();
    expect(sms.meterBatchId).toBeNull();
    expect(report.reportedToStripeAt).not.toBeNull();
    expect(report.stripeInvoiceItemId).not.toBeNull();

    await setBilling(a, 'cus_fake_1', 'sub_fake_1', 'active');
    await reportUsage(t.deps, NOW);

    expect(t.billing.meterEvents).toMatchObject([{ eventName: 'roofline_sms_segment', customerId: 'cus_fake_1', value: 3 }]);
    expect(t.billing.invoiceItems).toHaveLength(1);
    expect(await unreportedOf(a)).toHaveLength(0);
  });

  test("company B's usage never goes to A's customer", async () => {
    const a = idOf('a');
    const b = idOf('b');
    await setCustomer(a, 'cus_fake_1');
    await setCustomer(b, 'cus_fake_2');
    await addUsage(a, [{ kind: 'sms_segment', quantity: 1, unitCostCents: null, refId: 'a-sms-1', description: null }]);
    await addUsage(b, [
      { kind: 'sms_segment', quantity: 5, unitCostCents: null, refId: 'b-sms-1', description: null },
      { kind: 'exact_report', quantity: 1, unitCostCents: 4500, refId: 'b-report-1', description: EXACT },
    ]);

    await reportUsage(t.deps, NOW);

    expect(t.billing.meterEvents).toHaveLength(2);
    const pairs = t.billing.meterEvents.map((e) => ({ customerId: e.customerId, value: e.value })).sort((x, y) => x.customerId.localeCompare(y.customerId));
    expect(pairs).toEqual([
      { customerId: 'cus_fake_1', value: 1 },
      { customerId: 'cus_fake_2', value: 5 },
    ]);
    expect(t.billing.invoiceItems).toHaveLength(1);
    expect(t.billing.invoiceItems[0]).toMatchObject({ customerId: 'cus_fake_2', description: EXACT });
  });
});
