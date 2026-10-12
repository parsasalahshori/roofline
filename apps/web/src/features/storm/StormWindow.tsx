import type { TaskStatus } from '@roofline/shared';
import { Banner, Button, Card, EmptyState, Skeleton } from '@roofline/ui';
import { useApprovals, useMapArea } from '../../api/hooks.ts';
import type { TaskView } from '../../api/types.ts';
import { doors } from '../../copy/doors.ts';
import { storm } from '../../copy/storm.ts';
import { countedDrafts } from '../../shell/countedDrafts.ts';
import { useStorms } from './api.ts';
import { useStormLayer } from './layerApi.ts';
import type { StormSummary } from './types.ts';
import styles from './StormWindow.module.css';

/** The newest of the given plans, by when the agent drafted it. Undefined when there are none. */
function newestPlan(plans: TaskView[]): TaskView | undefined {
  return plans.reduce<TaskView | undefined>(
    (newest, plan) => (newest === undefined || Date.parse(plan.createdAt) > Date.parse(newest.createdAt) ? plan : newest),
    undefined,
  );
}

/** Newest day first. The list answer already leaves out dismissed storms; the query data is not changed. */
function visibleStorms(storms: StormSummary[]): StormSummary[] {
  return [...storms]
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

function StormRow({ item }: { item: StormSummary }) {
  const seePlan = item.planTaskId !== null && (item.planStatus === 'draft' || item.planStatus === 'awaiting_owner');
  return (
    <Card as="div" className={styles.row}>
      <h3 className={styles.place}>{item.placeName ?? item.day}</h3>
      {item.placeName ? <p className={styles.day}>{item.day}</p> : null}
      <p className={styles.size}>{storm.upTo(item.maxIn.toFixed(2))}</p>
      <p>{storm.customersHit(item.customersHit)}</p>
      <p>{storm.homesHit(item.homesHit)}</p>
      <p>{(item.planStatus === null ? undefined : storm.planStatus[item.planStatus as TaskStatus]) ?? storm.noPlan}</p>
      <div className={styles.actions}>
        <Button variant="ghost" href={'/storm/' + encodeURIComponent(item.id)}>
          {storm.viewStorm}
        </Button>
        {seePlan ? (
          <Button variant="ghost" href={'/storm/plans/' + encodeURIComponent(item.planTaskId as string)}>
            {storm.seePlan}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** The Storm window: the newest storm plan waiting for a yes, then the behind banner and the storms list. */
export function StormWindow() {
  const approvals = useApprovals();
  const storms = useStorms();
  const area = useMapArea();
  const layer = useStormLayer(area.data?.bounds ?? null, 6, true);
  const plan = newestPlan(countedDrafts(approvals.data).filter((task) => task.agent === 'storm_scout'));

  const rows = storms.data ? visibleStorms(storms.data.storms) : [];

  return (
    <>
      <div className={styles.routes}>
        <Button variant="ghost" href="/storm/routes">
          {doors.myRoutesLink}
        </Button>
      </div>
      {plan ? (
        <Card as="section" aria-label={storm.planHeading} className={styles.plan}>
          <h2>{plan.title}</h2>
          {plan.summary ? <p>{plan.summary}</p> : null}
          <Button variant="primary" href={'/storm/plans/' + encodeURIComponent(plan.id)}>
            {storm.approve}
          </Button>
        </Card>
      ) : null}
      {layer.data?.stale === true ? <Banner tone="warning">{storm.staleBanner}</Banner> : null}
      {storms.isPending ? (
        <div role="status" aria-label={storm.loading}>
          <Skeleton lines={3} />
        </div>
      ) : null}
      {storms.isError ? <p role="alert">{storm.loadFailed}</p> : null}
      {storms.data ? (
        <section aria-label={storm.listHeading} className={styles.list}>
          {rows.map((item) => (
            <StormRow key={item.id} item={item} />
          ))}
          {rows.length === 0 ? <EmptyState title={storm.empty} /> : null}
        </section>
      ) : null}
    </>
  );
}
