import { finishParkedStep, getTask, listParkedSteps, listWaitingExactOrders, moveExactOrder, touchExactOrderPolled, withTenant, type ExactOrderRow, type TenantContext } from '@roofline/db';
import { companiesWithWaitingExactOrders } from '@roofline/db/system';
import type { AppDeps } from '../../app.ts';
import { completeExactReport } from '../../estimator/exact-report-complete.ts';
import { systemContext } from '../../permissions.ts';
import { refreshTask } from '../../tasks/service.ts';
import { reportJobError } from './report.ts';

const POLL_GAP_MS = 10 * 60_000;
/** Our own sentence; the provider's reason is never stored or shown. */
const FAILED_PLAIN = 'The report could not be completed. Check with the report provider.';

/** Marks the order and its parked step as needing attention. */
async function failOrder(deps: AppDeps, ctx: TenantContext, order: ExactOrderRow, now: Date): Promise<void> {
  await withTenant(deps.pools, ctx, async (tx) => {
    const moved = await moveExactOrder(tx, ctx, order.id, 'waiting', 'attention', { errorPlain: FAILED_PLAIN }, now);
    if (!moved || order.taskId === null) return;
    const task = await getTask(tx, ctx, order.taskId, { forUpdate: true });
    if (!task) return;
    const steps = await listParkedSteps(tx, ctx, 'order_exact_report');
    const step = steps.find((s) => s.taskId === order.taskId);
    if (step) await finishParkedStep(tx, ctx, step.id, { status: 'needs_attention', result: { orderId: order.id }, errorPlain: FAILED_PLAIN }, now);
    await refreshTask(tx, ctx, order.taskId, now);
  });
}

/**
 * Every 10 minutes: asks the exact-report provider about orders still waiting (not polled in the last
 * 10 minutes). The provider is called outside any transaction. A complete report becomes an exact
 * measurement (the unreadable-cost case bills the order's quoted max, never 0); a failed one needs
 * attention. One order's or one company's failure never stops the rest.
 */
export async function pollExactReports(deps: AppDeps, now: Date): Promise<void> {
  if (!deps.exactReports.configured) return;
  const cutoff = new Date(now.getTime() - POLL_GAP_MS);
  for (const companyId of await companiesWithWaitingExactOrders(deps.pools.system, cutoff)) {
    const ctx = systemContext(companyId);
    try {
      const orders = await withTenant(deps.pools, ctx, (tx) => listWaitingExactOrders(tx, ctx, cutoff));
      for (const order of orders) {
        if (order.providerReportId === null) continue;
        try {
          const result = await deps.exactReports.report(order.providerReportId);
          await withTenant(deps.pools, ctx, (tx) => touchExactOrderPolled(tx, ctx, order.id, now));
          if (result.status === 'pending') continue;
          if (result.status === 'failed') {
            await failOrder(deps, ctx, order, now);
            continue;
          }
          // An unreadable cost bills the priced max; with neither, never bill 0: leave it waiting and report it.
          const cost = result.costCents ?? order.priceMaxCents;
          if (cost === null) throw new Error('exact report has no cost and no priced max');
          await completeExactReport(deps, ctx, order.id, result.report, cost, now);
        } catch (err) {
          reportJobError(deps, err, `exact-report-poll: order ${order.id}`);
          await withTenant(deps.pools, ctx, (tx) => touchExactOrderPolled(tx, ctx, order.id, now)).catch(() => undefined);
        }
      }
    } catch (err) {
      reportJobError(deps, err, `exact-report-poll: company ${companyId}`);
    }
  }
}
