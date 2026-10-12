import { markBatchReported, markInvoiced, meterTargetFor, openMeterBatches, unbilledInvoiceUsage, withTenant } from '@roofline/db';
import { companiesWithUnreportedUsage } from '@roofline/db/system';
import { invoiceAmountCents, METER_EVENT_NAME } from '@roofline/shared';
import type { AppDeps } from '../../app.ts';
import { billingConfig } from '../../billing/plans.ts';
import { systemContext } from '../../permissions.ts';
import { reportJobError } from './report.ts';

/**
 * Scheduled job (every minute): reports metered usage and passes through invoice items to the
 * billing provider. Skipped entirely while billing is not configured (`deps.billing.configured`
 * is false). For each company with unreported usage, in its own try/catch (a failure is logged once
 * and the rest waits for the next minute; the loop goes on to the next company):
 *
 * 1. Its Stripe customer id and whether it has a live subscription. No customer yet: the company is skipped.
 * 2. Its metered usage as one meter event per open batch (`openMeterBatches` gives each batch a
 *    fresh id and the batch's units), but only once the company has a live subscription: events sent
 *    before one exists would fall outside its billing period and never be billed, so the rows are held
 *    back (left unreported) until it does. The batch id is the event's `identifier`, so a resend after
 *    a crash is ignored by the provider; each batch is marked reported right after its event is sent.
 * 3. Its invoice rows (exact reports, texting registration fees, number fees), each as one invoice
 *    item with the idempotency key `usage:<row id>`, marked invoiced right after the item is created.
 *    These do not wait for a subscription: pending invoice items attach to the subscription's first invoice.
 *
 * No provider call runs inside a database transaction: each step is its own short `withTenant`
 * transaction, and the ids that matter (batch, invoice item) are committed before the next step.
 */
export async function reportUsage(deps: AppDeps, now: Date): Promise<void> {
  if (!deps.billing.configured) return;
  for (const companyId of await companiesWithUnreportedUsage(deps.pools.system)) {
    const ctx = systemContext(companyId);
    try {
      const { customerId, liveSubscription } = await withTenant(deps.pools, ctx, (tx) => meterTargetFor(tx, ctx));
      if (customerId === null) continue;

      if (liveSubscription) {
        const batches = await withTenant(deps.pools, ctx, (tx) => openMeterBatches(tx, ctx));
        for (const b of batches) {
          await deps.billing.reportMeterEvent({
            eventName: METER_EVENT_NAME[b.meter],
            customerId,
            value: b.value,
            identifier: b.batchId,
            timestamp: now,
          });
          await withTenant(deps.pools, ctx, (tx) => markBatchReported(tx, ctx, b.batchId, now));
        }
      }

      const rows = await withTenant(deps.pools, ctx, (tx) => unbilledInvoiceUsage(tx, ctx));
      for (const r of rows) {
        const { invoiceItemId } = await deps.billing.createInvoiceItem({
          customerId,
          amountCents: invoiceAmountCents(r.kind, r.quantity, r.unitCostCents, billingConfig(deps)),
          description: r.description,
          idempotencyKey: 'usage:' + r.id,
        });
        await withTenant(deps.pools, ctx, (tx) => markInvoiced(tx, ctx, r.id, invoiceItemId, now));
      }
    } catch (err) {
      reportJobError(deps, err, `report-usage: company ${companyId}`);
    }
  }
}
