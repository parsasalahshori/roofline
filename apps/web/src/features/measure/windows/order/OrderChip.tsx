import { Button, Pill } from '@roofline/ui';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { useMeasurementOrder } from './api.ts';

export const orderHref = (measurementId: string) => `/estimator/windows/${encodeURIComponent(measurementId)}/order`;

/**
 * For the windows screen: "Factory order: Draft" linking to the order, or a "Create factory order" button when the
 * measurement has none yet (the order page makes it). `hasPhotoWindows: false` hides the button: only windows measured
 * from on-site photos can be ordered.
 */
export function OrderStatusChip({ measurementId, hasPhotoWindows = true }: { measurementId: string; hasPhotoWindows?: boolean }) {
  const query = useMeasurementOrder(measurementId);
  if (query.data === undefined) return null;
  if (query.data === null) {
    return hasPhotoWindows ? (
      <Button variant="ghost" href={orderHref(measurementId)}>
        {copy.createOrder}
      </Button>
    ) : null;
  }
  return (
    <Pill tone="neutral" href={orderHref(measurementId)}>
      {copy.chip(copy.status[query.data.status])}
    </Pill>
  );
}
