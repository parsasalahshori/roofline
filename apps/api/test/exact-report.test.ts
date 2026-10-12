import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { agentTaskSteps, createMeasurement, exactReportOrders, type TenantContext } from '@roofline/db';
import { instantEstimate, invoiceAmountCents } from '@roofline/shared';
import { billingConfig } from '../src/billing/plans.ts';
import { NOT_SAVED_MESSAGE, orderExactReport, requestExactReport } from '../src/estimator/exact-report.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx, dbSteps, dbTask, seenOf } from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
const UNCERTAIN = 'Needs attention: check with the report provider before ordering again.';

let t: TestApp;
let actors: Actors;
let ctx: TenantContext;
let measurementId: string;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
  ctx = agentCtx(t.seed.a.companyId);
  const owner = await actors.as('owner');
  const property = await mustCreate(owner, '/api/properties', addressFor(1));
  const ring: [number, number][] = [[-96, 41.25], [-95.9997, 41.25], [-95.9997, 41.2502], [-96, 41.2502], [-96, 41.25]];
  const m = await inCompany(t, ctx.companyId, (tx) =>
    createMeasurement(
      tx,
      ctx,
      {
        propertyId: property.id,
        kind: 'estimate',
        method: 'outline',
        outline: null,
        structures: [{ footprintId: 'fp-1', included: true, areaSqFt: 2000, ring }],
        estimate: instantEstimate({ outline: [ring], pitchX12: 6, overhangFt: 1 }),
        overhangFt: 1,
        center: [-95.99985, 41.2501],
      },
      NOW,
    ),
  );
  measurementId = m.id;
});

const calls = (method: 'price' | 'order' | 'report') => t.exactReports.calls.filter((c) => c.method === method);
const order = async (orderId: string) =>
  (await inCompany(t, ctx.companyId, (tx) => tx.select().from(exactReportOrders).where(eq(exactReportOrders.id, orderId))))[0]!;

async function request() {
  const r = await requestExactReport(t.deps, ctx, measurementId);
  const steps = await dbSteps(t, 'a', r.taskId);
  return { ...r, step: steps[0]!, steps };
}

async function ownerApproves(taskId: string, steps: { id: string; version: number }[]) {
  const res = await (await actors.as('owner')).post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
}

describe('the exact report order flow', () => {
  test('request creates a task whose order step previews the max spend', async () => {
    const { orderId, step } = await request();
    const cfg = billingConfig(t.deps);
    expect(step.type).toBe('order_exact_report');
    expect(step.payload).toMatchObject({ orderId, measurementId, maxSpendCents: invoiceAmountCents('exact_report', 1, 6200, cfg) });
    expect((await order(orderId)).status).toBe('priced');
    expect(calls('price')).toHaveLength(1);
    expect(calls('order')).toHaveLength(0);
  });

  test('office approval leaves the step awaiting_owner', async () => {
    const { taskId, steps } = await request();
    const office = await actors.as('office');
    const res = await office.post(`/api/approvals/${taskId}/approve`).send(seenOf(steps));
    expect(res.status).toBe(200);
    expect((await dbSteps(t, 'a', taskId))[0]!.status).toBe('awaiting_owner');
    await t.queue.drain(t.deps);
    expect(calls('order')).toHaveLength(0);
  });

  test('owner approval orders once', async () => {
    const { taskId, orderId, steps } = await request();
    await ownerApproves(taskId, steps);
    await t.queue.drain(t.deps);
    expect(calls('order')).toHaveLength(1);
    const o = await order(orderId);
    expect(o.status).toBe('waiting');
    expect(o.providerReportId).toBe('rep-1');
    expect((await dbSteps(t, 'a', taskId))[0]!.status).toBe('running');
  });

  test('draining the step twice makes one order call', async () => {
    const { taskId, steps } = await request();
    await ownerApproves(taskId, steps);
    await t.queue.drain(t.deps);
    await t.queue.drain(t.deps);
    expect(calls('order')).toHaveLength(1);
    expect((await dbTask(t, 'a', taskId)).id).toBe(taskId);
  });

  test('an uncertain order goes to attention and is never called again', async () => {
    t.exactReports.orderUncertainNext();
    const { taskId, orderId, steps, step } = await request();
    await ownerApproves(taskId, steps);
    await t.queue.drain(t.deps);
    const after = (await dbSteps(t, 'a', taskId))[0]!;
    expect(after.status).toBe('needs_attention');
    expect(after.errorPlain).toBe(UNCERTAIN);
    const o = await order(orderId);
    expect(o.status).toBe('attention');
    expect(o.errorPlain).toBe(UNCERTAIN);
    // A rerun of the same step (the queue delivers it again) never orders again.
    await t.queue.enqueueStep(ctx.companyId, step.id);
    await t.queue.drain(t.deps);
    // ... and neither does the handler itself when it is called again.
    const again = await orderExactReport(t.deps, ctx, { ...step, payload: step.payload } as never);
    expect(again.status).toBe('needs_attention');
    expect(again.result).toEqual({ ordered: 0 });
    expect(calls('order')).toHaveLength(1);
    expect((await order(orderId)).status).toBe('attention');
  });

  test('an expired price within the approved max is re-priced then ordered', async () => {
    const { taskId, steps } = await request();
    await ownerApproves(taskId, steps);
    t.clock.advance(11 * 60_000);
    await t.queue.drain(t.deps);
    expect(calls('price')).toHaveLength(2);
    expect(calls('order')).toHaveLength(1);
  });

  test('a price above the approved max needs attention and orders nothing', async () => {
    const { taskId, orderId } = await request();
    // The owner approved a lower ceiling than the fake now quotes.
    const cfg = billingConfig(t.deps);
    const lower = invoiceAmountCents('exact_report', 1, 5000, cfg);
    await inCompany(t, ctx.companyId, async (tx) => {
      const [row] = await tx.select().from(agentTaskSteps).where(eq(agentTaskSteps.taskId, taskId));
      await tx.update(agentTaskSteps).set({ payload: { ...(row!.payload as object), maxSpendCents: lower } }).where(eq(agentTaskSteps.taskId, taskId));
    });
    t.clock.advance(11 * 60_000);
    await ownerApproves(taskId, (await dbSteps(t, 'a', taskId)).map((s) => ({ id: s.id, version: s.version })));
    await t.queue.drain(t.deps);
    expect(calls('order')).toHaveLength(0);
    const after = (await dbSteps(t, 'a', taskId))[0]!;
    expect(after.status).toBe('needs_attention');
    expect(after.errorPlain).toBe('The report price went up. Ask again.');
    expect((await order(orderId)).status).toBe('attention');
  });
});

describe('one open order per measurement (B4)', () => {
  test('asking again while the order is priced, ordered or waiting gives the same task and order', async () => {
    const first = await request();
    const again = await requestExactReport(t.deps, ctx, measurementId);
    expect(again).toEqual({ taskId: first.taskId, orderId: first.orderId });
    expect(calls('price')).toHaveLength(1);

    await ownerApproves(first.taskId, first.steps);
    await t.queue.drain(t.deps);
    expect((await order(first.orderId)).status).toBe('waiting');
    expect(await requestExactReport(t.deps, ctx, measurementId)).toEqual({ taskId: first.taskId, orderId: first.orderId });
    const orders = await inCompany(t, ctx.companyId, (tx) => tx.select().from(exactReportOrders).where(eq(exactReportOrders.measurementId, measurementId)));
    expect(orders).toHaveLength(1);
  });

  test('two requests at the same moment make one order', async () => {
    const [a, b] = await Promise.all([requestExactReport(t.deps, ctx, measurementId), requestExactReport(t.deps, ctx, measurementId)]);
    expect(b).toEqual(a);
    const orders = await inCompany(t, ctx.companyId, (tx) => tx.select().from(exactReportOrders).where(eq(exactReportOrders.measurementId, measurementId)));
    expect(orders).toHaveLength(1);
  });

  test('the route answers the second click with the first task (201)', async () => {
    const owner = await actors.as('owner');
    const one = await owner.post(`/api/measurements/${measurementId}/exact-report`).send({});
    const two = await owner.post(`/api/measurements/${measurementId}/exact-report`).send({});
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body).toEqual({ taskId: one.body.taskId });
  });

  test('an order that needed attention is not open: asking again makes a new one', async () => {
    t.exactReports.orderUncertainNext();
    const first = await request();
    await ownerApproves(first.taskId, first.steps);
    await t.queue.drain(t.deps);
    expect((await order(first.orderId)).status).toBe('attention');
    const again = await requestExactReport(t.deps, ctx, measurementId);
    expect(again.orderId).not.toBe(first.orderId);
  });
});

describe('a placed order whose save fails (C-I3)', () => {
  /** After the next successful order call, the next `n` tenant transactions fail as a database blip would. */
  function failSavesAfterOrder(n: number) {
    const tenant = t.deps.pools.tenant as unknown as { transaction: (...args: unknown[]) => Promise<unknown> };
    const realTransaction = tenant.transaction.bind(tenant);
    let failing = 0;
    tenant.transaction = (...args: unknown[]) => {
      if (failing > 0) {
        failing -= 1;
        return Promise.reject(new Error('connection lost'));
      }
      return realTransaction(...args);
    };
    const realOrder = t.exactReports.order.bind(t.exactReports);
    t.exactReports.order = async (input) => {
      const placed = await realOrder(input);
      failing = n;
      return placed;
    };
  }

  test('one failed write is tried again: the order waits with its report id', async () => {
    const { taskId, orderId, steps } = await request();
    await ownerApproves(taskId, steps);
    failSavesAfterOrder(1);
    await t.queue.drain(t.deps);
    const o = await order(orderId);
    expect(o.status).toBe('waiting');
    expect(o.providerReportId).toBe('rep-1');
    expect(calls('order')).toHaveLength(1);
  });

  test('two failed writes: never marked uncertain, our ids are logged, the step says not to order again', async () => {
    const { taskId, orderId, steps } = await request();
    await ownerApproves(taskId, steps);
    failSavesAfterOrder(2);
    await t.queue.drain(t.deps);
    const o = await order(orderId);
    expect(o.status).toBe('ordering');
    expect(o.errorPlain).toBeNull();
    const step = (await dbSteps(t, 'a', taskId))[0]!;
    expect(step.status).toBe('needs_attention');
    expect(step.errorPlain).toBe(NOT_SAVED_MESSAGE);
    expect(t.logged.some((l) => l.where.includes(orderId) && l.where.includes('rep-1'))).toBe(true);
    expect(calls('order')).toHaveLength(1);
  });
});
