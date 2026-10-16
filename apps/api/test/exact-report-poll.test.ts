import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { createMeasurement, exactReportOrders, getProposal, listTaskEvents, measurements, proposalOptions, proposals, usageEvents, withTenant, type TenantContext } from '@roofline/db';
import { instantEstimate } from '@roofline/shared';
import { buildProposal } from '../src/estimator/build.ts';
import { completeExactReport } from '../src/estimator/exact-report-complete.ts';
import { requestExactReport } from '../src/estimator/exact-report.ts';
import { billedCostCents, pollExactReports } from '../src/jobs/scheduler/exact-report-poll.ts';
import type { ExactReports } from '../src/providers/exact-reports.ts';
import { FakeExactReports } from '../src/providers/fakes/exact-reports.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { agentCtx, dbSteps, dbTask, seenOf } from './task-helpers.ts';

const NOW = new Date('2026-10-12T15:00:00.000Z');
/** The order is stamped polled when placed (at NOW), so polls run after the ten-minute gap. */
const LATER = new Date(NOW.getTime() + 11 * 60_000);

let t: TestApp;
let actors: Actors;
let ctx: TenantContext;
let ownerCtx: TenantContext;
let measurementId: string;
let jobId: string;
let propertyId: string;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  actors = new Actors(t);
  ctx = agentCtx(t.seed.a.companyId);
  ownerCtx = { companyId: ctx.companyId, userId: t.seed.a.owner.userId, role: 'owner', canApproveSpend: true };
  const owner = await actors.as('owner');
  const customer = await mustCreate(owner, '/api/customers', { displayName: 'Molly Lindgren' });
  const property = await mustCreate(owner, '/api/properties', { customerId: customer.id, ...addressFor(1) });
  const job = await mustCreate(owner, '/api/jobs', { customerId: customer.id, propertyId: property.id });
  propertyId = property.id;
  jobId = job.id;
  const ring: [number, number][] = [[-96, 41.25], [-95.9997, 41.25], [-95.9997, 41.2502], [-96, 41.2502], [-96, 41.25]];
  const m = await inCompany(t, ctx.companyId, (tx) =>
    createMeasurement(
      tx,
      ctx,
      {
        propertyId,
        jobId,
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

/** Requests a report, the owner approves, the step drains: the order is 'waiting' as rep-1. */
async function orderIt() {
  const r = await requestExactReport(t.deps, ctx, measurementId);
  const steps = await dbSteps(t, 'a', r.taskId);
  const res = await (await actors.as('owner')).post(`/api/approvals/${r.taskId}/approve`).send(seenOf(steps));
  expect(res.status).toBe(200);
  await t.queue.drain(t.deps);
  return r;
}

const dbOrder = async (orderId: string) =>
  (await inCompany(t, ctx.companyId, (tx) => tx.select().from(exactReportOrders).where(eq(exactReportOrders.id, orderId))))[0]!;
const exactMeasurements = () =>
  inCompany(t, ctx.companyId, (tx) => tx.select().from(measurements).where(eq(measurements.kind, 'exact')));
const usage = () => inCompany(t, ctx.companyId, (tx) => tx.select().from(usageEvents).where(eq(usageEvents.kind, 'exact_report')));
const reportCalls = () => t.exactReports.calls.filter((c) => c.method === 'report');
const proposalOf = (id: string) => withTenant(t.deps.pools, ownerCtx, (tx) => getProposal(tx, ownerCtx, id));
const allProposals = () => inCompany(t, ctx.companyId, (tx) => tx.select().from(proposals).where(eq(proposals.propertyId, propertyId)));

describe('polling exact reports', () => {
  test('a pending report stays waiting and is stamped polled; not asked again within ten minutes', async () => {
    const { orderId } = await orderIt();
    await pollExactReports(t.deps, new Date(NOW.getTime() + 5 * 60_000));
    expect(reportCalls()).toHaveLength(0);
    await pollExactReports(t.deps, LATER);
    const o = await dbOrder(orderId);
    expect(o.status).toBe('waiting');
    expect(o.lastPolledAt?.getTime()).toBe(LATER.getTime());
    expect(reportCalls()).toHaveLength(1);
    await pollExactReports(t.deps, new Date(LATER.getTime() + 5 * 60_000));
    expect(reportCalls()).toHaveLength(1);
    await pollExactReports(t.deps, new Date(LATER.getTime() + 11 * 60_000));
    expect(reportCalls()).toHaveLength(2);
  });

  test('a complete report makes an exact measurement', async () => {
    await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    const rows = await exactMeasurements();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'exact', method: 'eagleview', surfaceSqFt: 2612, pitchX12: 7, ridgeFt: 62, edgeFt: 188, eaveFt: 142, valleyFt: 24, facets: 9, providerRef: 'rep-1', propertyId, jobId });
  });

  test('one usage row at the report cost, even if completed twice', async () => {
    const { orderId } = await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 1, unitCostCents: 4500, refType: 'exact_report', refId: 'rep-1' });
    expect(rows[0]!.description?.startsWith('Exact roof report')).toBe(true);
    // A second run (the order is no longer waiting) changes nothing.
    const report = await t.exactReports.report('rep-1');
    if (report.status !== 'complete') throw new Error('expected a complete report');
    await completeExactReport(t.deps, ctx, orderId, report.report, report.costCents, NOW);
    await pollExactReports(t.deps, new Date(NOW.getTime() + 20 * 60_000));
    expect(await usage()).toHaveLength(1);
    expect(await exactMeasurements()).toHaveLength(1);
  });

  test('a draft proposal is re-priced in place', async () => {
    const draft = await buildProposal(t.deps, ownerCtx, { measurementId, jobId });
    await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    const [exact] = await exactMeasurements();
    const after = await proposalOf(draft.id);
    expect(after?.status).toBe('draft');
    expect(after?.measurementId).toBe(exact!.id);
    expect(after?.basis).toBe('exact');
    expect(await allProposals()).toHaveLength(1);
  });

  test('a sent proposal is untouched and a revised draft is made', async () => {
    const sent = await buildProposal(t.deps, ownerCtx, { measurementId, jobId });
    await inCompany(t, ctx.companyId, (tx) => tx.update(proposals).set({ status: 'sent', sentAt: NOW }).where(eq(proposals.id, sent.id)));
    const before = await proposalOf(sent.id);
    await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    expect(await proposalOf(sent.id)).toEqual(before);
    const rows = await allProposals();
    expect(rows).toHaveLength(2);
    const revised = rows.find((p) => p.id !== sent.id)!;
    expect(revised.status).toBe('draft');
    expect((await proposalOf(revised.id))?.basis).toBe('exact');
  });

  test('a ready proposal (its send awaiting approval) gets a revised draft too (Ruling EO)', async () => {
    const ready = await buildProposal(t.deps, ownerCtx, { measurementId, jobId });
    await inCompany(t, ctx.companyId, (tx) => tx.update(proposals).set({ status: 'ready' }).where(eq(proposals.id, ready.id)));
    await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    const rows = await allProposals();
    expect(rows).toHaveLength(2);
    const revised = rows.find((p) => p.id !== ready.id)!;
    expect(revised.status).toBe('draft');
    expect((await proposalOf(revised.id))?.basis).toBe('exact');
    // B1: the ready one is closed, pointing at the revision, so its waiting send texts nothing.
    const old = rows.find((p) => p.id === ready.id)!;
    expect(old.status).toBe('replaced');
    expect(old.replacedById).toBe(revised.id);
  });

  test("B10: a draft re-priced in place keeps the rep's per-option edits and prices the new quantities", async () => {
    const draft = await buildProposal(t.deps, ownerCtx, { measurementId, jobId });
    const [good, better] = draft.options;
    const owner = await actors.as('owner');
    const edited = await owner.patch(`/api/proposals/${draft.id}`).send({
      options: [
        { id: good!.id, enabled: false },
        { id: better!.id, name: 'Our pick', material: 'premium', markupPercent: 10, addOns: [] },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);

    const after = (await proposalOf(draft.id))!;
    expect(after.basis).toBe('exact');
    const g = after.options.find((o) => o.tier === 'good')!;
    const b = after.options.find((o) => o.tier === 'better')!;
    expect(g.enabled).toBe(false);
    expect(b).toMatchObject({ name: 'Our pick', addOns: [], addOnLines: [] });
    expect(b.scope).toMatchObject({ material: 'premium', markupPercent: 10, areaSqFt: 2612, pitch: 7, ridgeFt: 62, edgeFt: 188, valleyFt: 24 });
    const stored = await inCompany(t, ctx.companyId, (tx) => tx.select().from(proposalOptions).where(eq(proposalOptions.id, b.id)));
    expect((stored[0]!.prices as { quantities: unknown }).quantities).toEqual({ squares: 26.12, edgeFt: 188, ridgeFt: 62, valleyFt: 24 });
    expect(b.totalCents).toBe(b.calculation.totalCents);
  });

  test('B3: a reported cost above the priced max is billed at the max the owner approved', async () => {
    await orderIt();
    t.exactReports.complete('rep-1');
    const fake = t.exactReports;
    const dear: ExactReports = {
      configured: true,
      price: (i) => fake.price(i),
      order: (i) => fake.order(i),
      report: async (id) => {
        const r = await fake.report(id);
        return r.status === 'complete' ? { ...r, costCents: 9900 } : r;
      },
    };
    await pollExactReports({ ...t.deps, exactReports: dear }, LATER);
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitCostCents).toBe(6200);
  });

  test('B3: billedCostCents caps at the priced max and never bills 0', () => {
    expect(billedCostCents(4500, 6200)).toBe(4500);
    expect(billedCostCents(9900, 6200)).toBe(6200);
    expect(billedCostCents(null, 6200)).toBe(6200);
    expect(billedCostCents(0, 6200)).toBe(6200);
    expect(billedCostCents(-5, 6200)).toBe(6200);
    expect(billedCostCents(4500, null)).toBe(4500);
    expect(billedCostCents(null, null)).toBeNull();
    expect(billedCostCents(0, 0)).toBeNull();
  });

  test('an unreadable cost bills the quoted max, never zero', async () => {
    await orderIt();
    t.exactReports.complete('rep-1');
    const fake = t.exactReports;
    const noCost: ExactReports = {
      configured: true,
      price: (i) => fake.price(i),
      order: (i) => fake.order(i),
      report: async (id) => {
        const r = await fake.report(id);
        return r.status === 'complete' ? { ...r, costCents: null } : r;
      },
    };
    await pollExactReports({ ...t.deps, exactReports: noCost }, LATER);
    const rows = await usage();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitCostCents).toBe(6200);
  });

  test('a failed report sets the order to attention with our own sentence', async () => {
    class Failing extends FakeExactReports {
      override async report(id: string) {
        this.calls.push({ method: 'report', args: { reportId: id } });
        return { status: 'failed' as const, reasonKey: 'provider says no' };
      }
    }
    const { orderId, taskId } = await orderIt();
    await pollExactReports({ ...t.deps, exactReports: new Failing() }, LATER);
    const o = await dbOrder(orderId);
    const plain = 'The report could not be completed. Check with the report provider.';
    expect(o.status).toBe('attention');
    expect(o.errorPlain).toBe(plain);
    const step = (await dbSteps(t, 'a', taskId))[0]!;
    expect(step.status).toBe('needs_attention');
    expect(step.errorPlain).toBe(plain);
    // Ruling EN: nothing was ordered
    expect(step.result).toEqual({ ordered: 0 });
    expect(await exactMeasurements()).toHaveLength(0);
    expect(await usage()).toHaveLength(0);
  });

  test('the order is complete and its step done', async () => {
    const { orderId, taskId } = await orderIt();
    expect((await dbSteps(t, 'a', taskId))[0]!.status).toBe('running');
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    expect((await dbOrder(orderId)).status).toBe('complete');
    const [step] = await dbSteps(t, 'a', taskId);
    expect(step!.status).toBe('done');
    // Ruling EN: the step's result counts what was ordered
    expect(step!.result).toEqual({ ordered: 1 });
    expect((await dbTask(t, 'a', taskId)).status).toBe('done');
  });
});

/** A1 Ruling AX-H: a parked exact-report step finishes through the task service, with its snapshot and event. */
describe('exact-report steps record their outcome', () => {
  const events = (taskId: string) => inCompany(t, ctx.companyId, (tx) => listTaskEvents(tx, ctx, taskId));

  test('a completed report snapshots the minutes saved on the step and writes step_done', async () => {
    const { taskId } = await orderIt();
    t.exactReports.complete('rep-1');
    await pollExactReports(t.deps, LATER);
    const [step] = await dbSteps(t, 'a', taskId);
    expect(step).toMatchObject({ status: 'done', baselineKey: 'exact_report', units: 1, minutesPerUnit: 10, minutesSaved: 10 });
    expect((await dbTask(t, 'a', taskId)).minutesSaved).toBe(10);
    const log = await events(taskId);
    const done = log.filter((e) => e.kind === 'step_done');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ stepId: step!.id });
    expect(log.some((e) => e.kind === 'step_attention')).toBe(false);
  });

  test('a failed order writes step_attention and no snapshot', async () => {
    class Failing extends FakeExactReports {
      override async report(id: string) {
        this.calls.push({ method: 'report', args: { reportId: id } });
        return { status: 'failed' as const, reasonKey: 'provider says no' };
      }
    }
    const { taskId } = await orderIt();
    await pollExactReports({ ...t.deps, exactReports: new Failing() }, LATER);
    const [step] = await dbSteps(t, 'a', taskId);
    expect(step).toMatchObject({ status: 'needs_attention', baselineKey: null, units: null, minutesSaved: null });
    const log = await events(taskId);
    const attention = log.filter((e) => e.kind === 'step_attention');
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ stepId: step!.id });
    expect(log.some((e) => e.kind === 'step_done')).toBe(false);
  });
});
