import { Banner, Button, useToast } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { billing } from '../../copy/billing.ts';
import { usePortal } from './api.ts';
import styles from './ShellBanners.module.css';

/**
 * The banners under the top bar: the trial or plan has ended, or the payment failed. Nothing shows
 * while loading, on a trial, or on an active plan. The hooks run before any early return.
 */
export function ShellBanners() {
  const me = useMe();
  const portal = usePortal();
  const toast = useToast();
  const status = me.data?.company.status;
  const role = me.data?.role;

  if (status === 'trial_ended' || status === 'canceled') {
    const text = status === 'trial_ended' ? billing.banners.trialEnded : billing.banners.canceled;
    return (
      <div className={styles.slot}>
        <Banner
          tone="warning"
          action={<Button href="/settings/billing">{billing.banners.pickPlan}</Button>}
        >
          {text}
        </Banner>
      </div>
    );
  }

  if (status === 'past_due') {
    const action =
      role === 'owner' ? (
        <Button onClick={() => portal.mutate(undefined, { onError: (error) => toast.show(error.message, 'error') })} busy={portal.isPending}>
          {billing.banners.fixPayment}
        </Button>
      ) : (
        <span>{billing.banners.askOwner}</span>
      );
    return (
      <div className={styles.slot}>
        <Banner tone="danger" action={action}>
          {billing.banners.pastDue}
        </Banner>
      </div>
    );
  }

  return null;
}
