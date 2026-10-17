import type { BillingView } from '@roofline/shared';
import { Button, Panel, Tag, useToast } from '@roofline/ui';
import { billing } from '../../copy/billing.ts';
import { useChangePlan, useCheckout } from './api.ts';
import styles from './PlanPicker.module.css';

/** The plans as tiles. The company's own plan says so while its subscription is live; the others offer a way to choose them. */
export function PlanPicker({ view }: { view: BillingView }) {
  const toast = useToast();
  const checkout = useCheckout();
  const changePlan = useChangePlan();

  const onError = (error: Error) => toast.show(error.message, 'error');
  // One primary button in the view: the only plan, or the plan the company already chose. With several to pick from and
  // none chosen yet no plan is pushed, so every "Pick this plan" is the plain button.
  const leadKey = view.plans.length === 1 ? view.plans[0]?.key : view.planKey;

  return (
    <Panel title={billing.plansHeading}>
      <ul className={styles.list}>
        {view.plans.map((plan) => {
          const current = view.hasPaymentMethod && plan.key === view.planKey;
          return (
            <li key={plan.key} className={styles.plan} data-current={current ? 'true' : undefined}>
              <h3 className={styles.name}>{plan.name}</h3>
              <p className={styles.price}>{billing.perMonth(plan.monthlyPriceCents)}</p>
              <p className={styles.includes}>
                {billing.includes(plan.included.aiCallMinutes, plan.included.smsSegments)}
              </p>
              {current ? (
                <p className={styles.current}>
                  <Tag tone="brand" icon="check">
                    {billing.yourPlan}
                  </Tag>
                </p>
              ) : view.hasPaymentMethod ? (
                <Button
                  variant="default"
                  onClick={() => changePlan.mutate(plan.key, { onError })}
                  busy={changePlan.isPending && changePlan.variables === plan.key}
                >
                  {billing.switchPlan}
                </Button>
              ) : (
                <Button
                  variant={plan.key === leadKey ? 'primary' : 'default'}
                  onClick={() => checkout.mutate(plan.key, { onError })}
                  busy={checkout.isPending && checkout.variables === plan.key}
                >
                  {billing.pickPlan}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <p className={styles.note}>{billing.cardNote}</p>
    </Panel>
  );
}
