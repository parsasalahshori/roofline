import type { BackofficeOrder, BackofficeSettings } from '@roofline/shared';

/** The limit in days for the order's stage, when the company set one. */
export function stuckLimit(order: Pick<BackofficeOrder, 'stage'>, settings: BackofficeSettings | undefined): number | null {
  const limit = settings?.stuckDays[order.stage];
  return typeof limit === 'number' && limit > 0 ? limit : null;
}

/** An order is stuck when it has sat in its stage for the limit or longer (no limit set: never stuck). */
export function isStuck(order: Pick<BackofficeOrder, 'stage' | 'daysInStage'>, settings: BackofficeSettings | undefined): boolean {
  const limit = stuckLimit(order, settings);
  return limit !== null && order.daysInStage >= limit;
}
