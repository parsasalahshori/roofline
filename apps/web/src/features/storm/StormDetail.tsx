import { Button, Card, EmptyState, Skeleton, StatCard, useToast } from '@roofline/ui';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { storm } from '../../copy/storm.ts';
import { useDismissStorm, useRedraftStorm, useStorm } from './api.ts';
import { StormResults } from './StormResults.tsx';
import { StormSwathMap } from './StormSwathMap.tsx';
import styles from './StormDetail.module.css';

/** One storm: where hail fell, who it hit, the plan, and the results so far. */
export function StormDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const q = useStorm(id);
  const me = useMe();
  const dismiss = useDismissStorm();
  const redraft = useRedraftStorm();
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();

  function showError(error: Error) {
    toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
  }

  if (q.isPending) return <Skeleton lines={4} />;
  if (q.isError || !q.data) return <EmptyState title={storm.notFound} />;

  const data = q.data;
  const role = me.data?.role;
  const canAct = role === 'owner' || role === 'office';
  const item = data.storm;

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>{item.placeName ?? item.day}</h1>
      <p className={styles.size}>{storm.upTo(item.maxIn.toFixed(2))}</p>
      <div className={styles.stats}>
        <StatCard label={storm.customersHit(item.customersHit)} value={item.customersHit} />
        <StatCard label={storm.homesHit(item.homesHit)} value={item.homesHit} />
      </div>
      <StormSwathMap swath={data.swath} />
      <Card as="section" aria-label={storm.planHeadingDetail} className={styles.plan}>
        {data.plan ? (
          <Button href={'/storm/plans/' + encodeURIComponent(data.plan.taskId)}>{storm.openPlan}</Button>
        ) : canAct ? (
          <Button
            variant="primary"
            disabled={redraft.isPending}
            onClick={() => {
              redraft.mutate(id, { onError: showError });
            }}
          >
            {redraft.isPending ? storm.redrafting : storm.redraft}
          </Button>
        ) : null}
      </Card>
      <StormResults results={data.results} running={data.plan?.status === 'running'} />
      {canAct && !confirming ? (
        <div className={styles.actions}>
          <Button
            variant="ghost"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {storm.dismiss}
          </Button>
        </div>
      ) : null}
      {canAct && confirming ? (
        <div role="alertdialog" aria-label={storm.dismissConfirmTitle} className={styles.confirm}>
          <h2>{storm.dismissConfirmTitle}</h2>
          <p>{storm.dismissConfirmBody}</p>
          <div className={styles.actions}>
            <Button
              disabled={dismiss.isPending}
              onClick={() => {
                dismiss.mutate(id, {
                  onSuccess: () => {
                    void navigate('/storm');
                  },
                  onError: showError,
                });
              }}
            >
              {storm.dismissConfirm}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {storm.dismissCancel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
