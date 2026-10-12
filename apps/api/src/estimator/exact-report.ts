import { randomUUID } from 'node:crypto';
import {
  claimExactOrder,
  findOpenExactOrder,
  getExactOrder,
  getMeasurementBasics,
  getProperty,
  insertExactOrder,
  lockMeasurementForOrder,
  moveExactOrder,
  setExactOrderTask,
  updateExactOrderPrice,
  withTenant,
  type TenantContext,
} from '@roofline/db';
import { invoiceAmountCents, stepTypes } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import { AppError, logErrorToConsole, MESSAGES } from '../errors.ts';
import { ExactOrderUncertainError, ExactReportsUnavailableError, type ExactOrderInput } from '../providers/exact-reports.ts';
import { billingConfig } from '../billing/plans.ts';
import { createTask } from '../tasks/service.ts';
import type { StepHandler, StepOutcome } from '../tasks/runner.ts';

/*
 * The exact report flow, the money path. price (no transaction) -> order row 'priced' + a draft
 * task whose step shows the max spend -> the owner approves (R2) -> the handler claims the row
 * (priced -> ordering) in a transaction of its own BEFORE the provider is called -> waiting.
 * An uncertain order is never retried; the plain message is ours, never the provider's text.
 */
export { completeExactReport } from './exact-report-complete.ts';

const NOT_SET_UP = "Exact reports aren't set up yet.";
export const UNCERTAIN_MESSAGE = 'Needs attention: check with the report provider before ordering again.';
export const PRICE_WENT_UP_MESSAGE = 'The report price went up. Ask again.';
/** The report was ordered but its id could not be saved: someone must pick it up, never order it again. */
export const NOT_SAVED_MESSAGE = "The report was ordered, but we couldn't save it. Don't order it again; we're looking into it.";

async function priceOrThrow(deps: AppDeps, input: ExactOrderInput) {
  try {
    return await deps.exactReports.price(input);
  } catch (e) {
    if (e instanceof ExactReportsUnavailableError) throw new AppError(503, NOT_SET_UP);
    throw e;
  }
}

/**
 * Prices a report for the measurement's home and makes the draft task the owner approves. A measurement that
 * already has an open order (asked for, approved, or on its way) gets that order's task back instead (B4), so
 * two clicks never make two orders that could both be approved and billed.
 */
export async function requestExactReport(
  deps: AppDeps,
  ctx: TenantContext,
  measurementId: string,
): Promise<{ taskId: string; orderId: string }> {
  const found = await withTenant(deps.pools, ctx, async (tx) => {
    const m = await getMeasurementBasics(tx, ctx, measurementId);
    if (!m) throw new AppError(404, MESSAGES.notFound);
    const p = await getProperty(tx, ctx, m.propertyId);
    if (!p) throw new AppError(404, MESSAGES.notFound);
    const open = await findOpenExactOrder(tx, ctx, measurementId);
    return { open, address: { street: p.addressLine, city: p.city, state: p.state, zip: p.zip } };
  });
  if (found.open) return { taskId: found.open.taskId, orderId: found.open.id };
  const { address } = found;
  if (!deps.exactReports.configured) throw new AppError(503, NOT_SET_UP);

  const productId = deps.config.EAGLEVIEW_PRODUCT_ID;
  const referenceId = randomUUID();
  const price = await priceOrThrow(deps, { address, productId, referenceId });

  const now = deps.clock.now();
  const maxSpendCents = invoiceAmountCents('exact_report', 1, price.maxCents, billingConfig(deps));
  const oneLine = `${address.street}, ${address.city}, ${address.state} ${address.zip}`;
  return withTenant(deps.pools, ctx, async (tx) => {
    // The measurement's row lock makes the check and the insert one step: a request that raced this one
    // waits here, then finds this order (the price asked for meanwhile is simply not used).
    if (!(await lockMeasurementForOrder(tx, ctx, measurementId))) throw new AppError(404, MESSAGES.notFound);
    const open = await findOpenExactOrder(tx, ctx, measurementId);
    if (open) return { taskId: open.taskId, orderId: open.id };
    const order = await insertExactOrder(
      tx,
      ctx,
      {
        measurementId,
        priceMinCents: price.minCents,
        priceMaxCents: price.maxCents,
        priceExpiresAt: price.expiresAt,
        providerProductId: String(productId),
        referenceId,
      },
      now,
    );
    const { taskId } = await createTask(
      tx,
      ctx,
      {
        agent: 'estimator',
        kind: 'exact_report',
        title: 'Order an exact roof report',
        subjectType: 'measurement',
        subjectId: measurementId,
        steps: [{ type: 'order_exact_report', payload: { orderId: order.id, measurementId, address: oneLine, maxSpendCents } }],
      },
      { now },
    );
    await setExactOrderTask(tx, ctx, order.id, taskId, now);
    return { taskId, orderId: order.id };
  });
}

/** Parses "street, city, state zip" back into the provider's address; the order row has no address, the step does. */
function parseAddress(line: string): ExactOrderInput['address'] {
  const parts = line.split(',').map((s) => s.trim());
  const last = parts.pop() ?? '';
  const city = parts.pop() ?? '';
  const [state = '', zip = ''] = last.split(/\s+/);
  return { street: parts.join(', '), city, state, zip };
}

/** The approved step: claims the order, re-prices if the price expired, orders once, parks the step. */
export const orderExactReport: StepHandler = async (deps, ctx, step): Promise<StepOutcome> => {
  const payload = stepTypes['order_exact_report'].payload.parse(step.payload);
  const { orderId } = payload;

  // (a) Claim in a transaction of its own, before any provider call.
  const claimed = await withTenant(deps.pools, ctx, (tx) => claimExactOrder(tx, ctx, orderId, deps.clock.now()));
  if (!claimed) {
    const existing = await withTenant(deps.pools, ctx, (tx) => getExactOrder(tx, ctx, orderId));
    if (existing?.status === 'waiting') return { status: 'running', result: {} };
    // Ruling EN: the result counts what was ordered (A1 reads it for time saved).
    if (existing?.status === 'complete') return { status: 'done', result: { ordered: 1 } };
    return { status: 'needs_attention', result: { ordered: 0 }, errorPlain: UNCERTAIN_MESSAGE };
  }

  const input = (referenceId: string): ExactOrderInput => ({
    address: parseAddress(payload.address),
    productId: Number(claimed.providerProductId ?? deps.config.EAGLEVIEW_PRODUCT_ID),
    referenceId,
  });
  const orderInput = input(claimed.referenceId);

  // (b) A price past its time is asked for again; a higher one than the owner approved stops here.
  let maxCents = claimed.priceMaxCents ?? 0;
  if (claimed.priceExpiresAt === null || claimed.priceExpiresAt.getTime() <= deps.clock.now().getTime()) {
    let fresh;
    try {
      fresh = await deps.exactReports.price(orderInput);
    } catch (e) {
      // Nothing was ordered: give the claim back so the retry can claim again.
      await withTenant(deps.pools, ctx, (tx) => moveExactOrder(tx, ctx, orderId, 'ordering', 'priced', {}, deps.clock.now()));
      throw e;
    }
    maxCents = fresh.maxCents;
    await withTenant(deps.pools, ctx, (tx) =>
      updateExactOrderPrice(tx, ctx, orderId, { priceMinCents: fresh.minCents, priceMaxCents: fresh.maxCents, priceExpiresAt: fresh.expiresAt }, deps.clock.now()),
    );
  }
  if (invoiceAmountCents('exact_report', 1, maxCents, billingConfig(deps)) > payload.maxSpendCents) {
    await withTenant(deps.pools, ctx, (tx) =>
      moveExactOrder(tx, ctx, orderId, 'ordering', 'attention', { errorPlain: PRICE_WENT_UP_MESSAGE }, deps.clock.now()),
    );
    return { status: 'needs_attention', result: { ordered: 0 }, errorPlain: PRICE_WENT_UP_MESSAGE };
  }

  // (c) Order, outside any transaction. Any failure here may still have taken effect: never retried.
  let reportId: string;
  try {
    ({ reportId } = await deps.exactReports.order(orderInput));
  } catch (e) {
    if (!(e instanceof ExactOrderUncertainError)) (deps.logError ?? logErrorToConsole)(e, 'order_exact_report');
    await withTenant(deps.pools, ctx, (tx) =>
      moveExactOrder(tx, ctx, orderId, 'ordering', 'attention', { errorPlain: UNCERTAIN_MESSAGE }, deps.clock.now()),
    );
    return { status: 'needs_attention', result: {}, errorPlain: UNCERTAIN_MESSAGE };
  }

  // (d) The order is placed and paid for: its report id must be kept (C-I3). The write is tried twice; if both
  // fail, our ids go to the log so the order can be picked up by hand, and it is never called uncertain.
  const saveWaiting = () => {
    const at = deps.clock.now();
    return withTenant(deps.pools, ctx, (tx) => moveExactOrder(tx, ctx, orderId, 'ordering', 'waiting', { providerReportId: reportId, lastPolledAt: at }, at));
  };
  try {
    await saveWaiting();
  } catch {
    try {
      await saveWaiting();
    } catch (e) {
      (deps.logError ?? logErrorToConsole)(e, `order_exact_report: order ${orderId} was placed as report ${reportId} but not saved`);
      return { status: 'needs_attention', result: { ordered: 1 }, errorPlain: NOT_SAVED_MESSAGE };
    }
  }
  return { status: 'running', result: {} };
};
