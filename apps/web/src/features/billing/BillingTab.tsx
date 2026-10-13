import { useEffect, useRef } from 'react';
import type { BillingView } from '@roofline/shared';
import { Button, Card, EmptyState, Skeleton, useToast } from '@roofline/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { useMe } from '../../api/hooks.ts';
import { ApiError } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import { billing } from '../../copy/billing.ts';
import { errors } from '../../copy/errors.ts';
import { billingKey, useBilling, usePortal } from './api.ts';
import styles from './BillingTab.module.css';
import { PlanPicker } from './PlanPicker.tsx';
import { UsageMeters } from './UsageMeters.tsx';

/** The day a trial ends, such as "Oct 25". */
function formatDay(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** The line under the plan name: the trial's end day, or the status. */
function statusText(view: BillingView): string {
  switch (view.status) {
    case 'trial':
      return view.trialEndsAt ? billing.trialUntil(formatDay(view.trialEndsAt)) : billing.statusLabel.trial;
    case 'active':
      return billing.statusLabel.active;
    case 'past_due':
      return billing.statusLabel.pastDue;
    case 'trial_ended':
      return billing.statusLabel.trialEnded;
    case 'canceled':
      return billing.statusLabel.canceled;
  }
}

/** The Billing settings tab. Only the owner sees the plan; everyone else sees a note. */
export function BillingTab() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const queryClient = useQueryClient();
  const me = useMe();
  const view = useBilling();
  const portal = usePortal();
  const handled = useRef(false);

  // Stripe Checkout returns here. Toast once, refresh what the plan changed, and drop the flag so a reload stays quiet.
  const checkoutDone = params.get('checkout') === 'done';
  useEffect(() => {
    if (!checkoutDone) {
      handled.current = false;
      return;
    }
    if (handled.current) return;
    handled.current = true;
    toast.show(billing.thanks);
    void queryClient.invalidateQueries({ queryKey: keys.me });
    void queryClient.invalidateQueries({ queryKey: billingKey });
    setParams({}, { replace: true });
  }, [checkoutDone, toast, queryClient, setParams]);

  if (me.data !== undefined && me.data.role !== 'owner') {
    return <EmptyState title={billing.ownerOnly} />;
  }
  if (view.data === undefined) {
    return view.isError ? (
      <EmptyState
        title={view.error instanceof ApiError ? view.error.message : errors.generic}
        action={<Button variant="primary" onClick={() => void view.refetch()}>{errors.tryAgain}</Button>}
      />
    ) : <div role="status" aria-label={billing.loading}><Skeleton lines={4} /></div>;
  }

  const data = view.data;
  return (
    <div className={styles.page}>
      <Card as="section" className={styles.summary}>
        <p className={styles.eyebrow}>{billing.currentPlan}</p>
        <h2 className={styles.planName}>{data.planName ?? billing.noPlan}</h2>
        <p className={styles.status}>{statusText(data)}</p>
      </Card>
      <UsageMeters usage={data.usage} />
      <PlanPicker view={data} />
      {data.canOpenPortal ? (
        <div>
          <Button variant="ghost" onClick={() => portal.mutate(undefined, { onError: (error) => toast.show(error.message, 'error') })} busy={portal.isPending}>
            {billing.invoicesAndCard}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
