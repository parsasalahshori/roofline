import { and, eq, inArray } from 'drizzle-orm';
import {
  addActivity,
  createMeasurement,
  finishParkedStep,
  getExactOrder,
  getMeasurement,
  getTask,
  listParkedSteps,
  measurements,
  moveExactOrder,
  properties,
  proposals,
  recordUsage,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import type { AppDeps } from '../app.ts';
import type { ExactReport } from '../providers/exact-reports.ts';
import { reportJobError } from '../jobs/scheduler/report.ts';
import { refreshTask } from '../tasks/service.ts';
import { repriceFromMeasurement } from './reprice.ts';

/** Proposals a new exact measurement may re-price: a draft in place, a sent or viewed one by a revised draft (reprice's own rule). */
// Ruling EO: 'ready' (a send awaiting approval) is re-priced too; reprice makes it a revised draft, so the owner
// never approves a text with the old estimate prices. Signed proposals are skipped (Ruling EJ).
const OPEN_PROPOSAL_STATUSES = ['draft', 'ready', 'sent', 'viewed'] as const;

/**
 * A waiting order whose report is ready: writes the exact measurement, records the usage once, marks
 * the order complete and finishes its parked step, all in one transaction. Then, after that commits,
 * re-prices the home's open proposals (a failure there never undoes the billing). Safe to run twice:
 * an order that is no longer waiting is left alone.
 */
export async function completeExactReport(
  deps: AppDeps,
  ctx: TenantContext,
  orderId: string,
  r: ExactReport,
  costCents: number,
  now: Date,
): Promise<void> {
  const done = await withTenant(deps.pools, ctx, async (tx) => {
    const order = await getExactOrder(tx, ctx, orderId);
    if (!order || order.status !== 'waiting') return null;
    // Claim the completion first: a second poller (another instance) finds the order no longer waiting and stops,
    // so only one exact measurement is made per report.
    if (!(await moveExactOrder(tx, ctx, orderId, 'waiting', 'complete', { errorPlain: null }, now))) return null;
    const source = await getMeasurement(tx, ctx, order.measurementId);
    if (!source) return null;
    const [home] = await tx
      .select({ addressLine: properties.addressLine, city: properties.city, state: properties.state, zip: properties.zip })
      .from(properties)
      .where(and(eq(properties.companyId, ctx.companyId), eq(properties.id, source.propertyId)))
      .limit(1);
    const address = home ? `${home.addressLine}, ${home.city}, ${home.state} ${home.zip}` : '';

    const created = await createMeasurement(
      tx,
      ctx,
      {
        propertyId: source.propertyId,
        jobId: source.jobId,
        kind: 'exact',
        method: 'eagleview',
        outline: source.outline,
        structures: source.structures,
        estimate: {
          footprintSqFt: source.estimate.footprintSqFt,
          planSqFt: source.estimate.planSqFt,
          surfaceSqFt: r.surfaceSqFt,
          squares: Math.round((r.surfaceSqFt / 100) * 100) / 100,
          edgeFt: r.edgeFt,
          ridgeFt: r.ridgeFt,
          valleyFt: r.valleyFt,
          pitchX12: r.pitchX12,
        },
        overhangFt: source.overhangFt,
        center: source.center,
      },
      now,
    );
    // createMeasurement does not store the report's facet count or reference.
    await tx
      .update(measurements)
      .set({ facets: r.facets, providerRef: r.reportRef, updatedAt: now })
      .where(and(eq(measurements.companyId, ctx.companyId), eq(measurements.id, created.id)));

    // Once per report: recordUsage is idempotent on (company, kind, refType, refId).
    await recordUsage(tx, ctx, {
      kind: 'exact_report',
      quantity: 1,
      unitCostCents: costCents,
      refType: 'exact_report',
      refId: order.providerReportId ?? order.id,
      description: `Exact roof report — ${address}`,
      at: now,
    });

    if (source.jobId !== null) {
      await addActivity(tx, ctx, {
        subjectType: 'job',
        subjectId: source.jobId,
        kind: 'measurement.exact',
        summary: 'Exact roof report received',
        at: now,
      });
    }

    // The parked step: lock the task first, then the step, then refresh the task.
    if (order.taskId !== null) {
      const task = await getTask(tx, ctx, order.taskId, { forUpdate: true });
      if (task) {
        const steps = await listParkedSteps(tx, ctx, 'order_exact_report');
        const step = steps.find((s) => s.taskId === order.taskId);
        if (step) await finishParkedStep(tx, ctx, step.id, { status: 'done', result: { ordered: 1 } }, now);
        await refreshTask(tx, ctx, order.taskId, now);
      }
    }
    return { measurementId: created.id, propertyId: source.propertyId };
  });
  if (done === null) return;

  // Re-price after the commit: repriceFromMeasurement opens its own transaction.
  const open = await withTenant(deps.pools, ctx, (tx) =>
    tx
      .select({ id: proposals.id })
      .from(proposals)
      .where(
        and(
          eq(proposals.companyId, ctx.companyId),
          eq(proposals.propertyId, done.propertyId),
          inArray(proposals.status, [...OPEN_PROPOSAL_STATUSES]),
        ),
      ),
  );
  for (const p of open) {
    try {
      await repriceFromMeasurement(deps, ctx, p.id, done.measurementId);
    } catch (err) {
      reportJobError(deps, err, `exact-report: reprice proposal ${p.id}`);
    }
  }
}
