import { Button, Card } from '@roofline/ui';
import { useApprovals } from '../../api/hooks.ts';
import type { TaskView } from '../../api/types.ts';
import { storm } from '../../copy/storm.ts';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { ComingSoon } from '../coming-soon/ComingSoon.tsx';
import styles from './StormWindow.module.css';

/** The newest of the given plans, by when the agent drafted it. Undefined when there are none. */
function newestPlan(plans: TaskView[]): TaskView | undefined {
  return plans.reduce<TaskView | undefined>(
    (newest, plan) => (newest === undefined || Date.parse(plan.createdAt) > Date.parse(newest.createdAt) ? plan : newest),
    undefined,
  );
}

/** The Storm window: the coming-soon line, and under it the newest storm plan waiting for a yes, if there is one. */
export function StormWindow() {
  const approvals = useApprovals();
  const plan = newestPlan(countedDrafts(approvals.data).filter((task) => task.agent === 'storm_scout'));

  return (
    <>
      <ComingSoon app="storm" />
      {plan ? (
        <Card as="section" aria-label={storm.planHeading} className={styles.plan}>
          <h2>{plan.title}</h2>
          {plan.summary ? <p>{plan.summary}</p> : null}
          <Button variant="primary" href={'/storm/plans/' + encodeURIComponent(plan.id)}>
            {storm.approve}
          </Button>
        </Card>
      ) : null}
    </>
  );
}
