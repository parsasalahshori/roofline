import type { BillingView } from '@roofline/shared';
import { Button, Card, useToast } from '@roofline/ui';
import { billing } from '../../copy/billing.ts';
import { errors } from '../../copy/errors.ts';
import { useChangePlan, useCheckout } from './api.ts';
import styles from './PlanPicker.module.css';

/** The plans as cards. The company's own plan says so; the others offer a way to choose them. */
export function PlanPicker({ view }: { view: BillingView }) {
  const toast = useToast();
  const checkout = useCheckout();
  const changePlan = useChangePlan();

  const onError = () => toast.show(errors.generic, 'error');

  return (
    <section className={styles.section}>
      <h3 className={styles.heading}>{billing.plansHeading}</h3>
      <ul className={styles.list}>
        {view.plans.map((plan) => {
          const current = plan.key === view.planKey;
          return (
            <Card as="li" key={plan.key} className={styles.plan}>
              <h4 className={styles.name}>{plan.name}</h4>
              <p className={styles.price}>{billing.perMonth(plan.monthlyPriceCents)}</p>
              <p className={styles.includes}>
                {billing.includes(plan.included.aiCallMinutes, plan.included.smsSegments)}
              </p>
              {current ? (
                <p className={styles.current}>{billing.yourPlan}</p>
              ) : view.hasPaymentMethod ? (
                <Button
                  onClick={() => changePlan.mutate(plan.key, { onError })}
                  busy={changePlan.isPending && changePlan.variables === plan.key}
                >
                  {billing.switchPlan}
                </Button>
              ) : (
                <Button
                  onClick={() => checkout.mutate(plan.key, { onError })}
                  busy={checkout.isPending && checkout.variables === plan.key}
                >
                  {billing.pickPlan}
                </Button>
              )}
            </Card>
          );
        })}
      </ul>
      <p className={styles.note}>{billing.cardNote}</p>
    </section>
  );
}
