import { Button, EmptyState, KpiTile, Panel, Skeleton, Tag, useToast } from '@roofline/ui';
import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { storm } from '../../copy/storm.ts';
import { AppPage } from '../../shell/AppPage.tsx';
import { useDismissStorm, useRedraftStorm, useStorm } from './api.ts';
import { count, hailName, hailSize, stormDay, stormDayLong } from './format.ts';
import { planTag } from './planTag.ts';
import { StormResults } from './StormResults.tsx';
import { StormSwathMap } from './StormSwathMap.tsx';
import styles from './StormDetail.module.css';

/** The one sentence under the plan's tag: where the plan stands. */
function planLine(status: string | undefined): string {
  switch (status) {
    case undefined:
      return storm.planPanelNone;
    case 'draft':
    case 'awaiting_owner':
      return storm.planPanelWaiting;
    case 'approved':
    case 'running':
      return storm.planPanelRunning;
    case 'declined':
    case 'expired':
      return storm.planPanelOver;
    default:
      return storm.planPanelDone;
  }
}

/** The page while a storm loads, or when it cannot be found: the Storm page's own head, then the message. */
function Shell({ children }: { children: ReactNode }) {
  return (
    <AppPage app="storm" crumbs={[{ label: storm.crumbStorm, href: '/storm' }]}>
      {children}
    </AppPage>
  );
}

/**
 * One storm: where hail fell (a map with its key), who it hit (the strip of numbers), the plan and what its results are so
 * far. The owner and office can draft a plan again and dismiss the storm.
 */
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

  if (q.isPending) {
    return (
      <Shell>
        <Skeleton lines={4} />
      </Shell>
    );
  }
  if (q.isError || !q.data) {
    return (
      <Shell>
        <EmptyState title={storm.notFound} />
      </Shell>
    );
  }

  const data = q.data;
  const role = me.data?.role;
  const canAct = role === 'owner' || role === 'office';
  const item = data.storm;
  const planStatus = data.plan?.status;
  /** An expired or declined plan is over: only a new one makes sense. */
  const plansReplaced = planStatus === 'expired' || planStatus === 'declined';
  const canRedraft = data.plan === null || planStatus === 'draft' || plansReplaced;
  const waiting = planStatus === 'draft' || planStatus === 'awaiting_owner';
  const name = item.placeName ?? stormDay(item.day);
  const tag = planTag(data.plan === null ? null : (planStatus ?? null));
  const showOpen = data.plan !== null && !plansReplaced;

  return (
    <AppPage
      app="storm"
      heading={name}
      eyebrow={stormDayLong(item.day)}
      subtitle={false}
      crumbs={[
        { label: storm.crumbStorm, href: '/storm' },
        { label: name },
      ]}
      stats={
        <div className={styles.stats}>
          <KpiTile
            label={storm.hailSizeLabel}
            value={hailSize(item.maxIn)}
            unit={storm.hailUnit}
            meta={storm.hailSizeMeta(hailName(item.maxIn))}
          />
          <KpiTile label={storm.customersHitLabel} value={count(item.customersHit)} meta={storm.insideSwath} />
          <KpiTile label={storm.homesHitLabel} value={count(item.homesHit)} meta={storm.insideSwath} />
        </div>
      }
    >
      <div className={styles.page}>
        <div className={styles.top}>
          <div className={styles.map}>
            <StormSwathMap swath={data.swath} />
          </div>
          <Panel
            as="section"
            title={storm.planPanelTitle}
            aria-label={storm.planHeadingDetail}
            tag={
              <Tag tone={tag.tone} icon={tag.icon}>
                {tag.label}
              </Tag>
            }
          >
            <div className={styles.plan}>
              <p className={styles.line}>{planLine(planStatus)}</p>
              {showOpen || (canAct && canRedraft) ? (
                <div className={styles.buttons}>
                  {showOpen && data.plan ? (
                    <Button variant={waiting ? 'primary' : 'default'} href={'/storm/plans/' + encodeURIComponent(data.plan.taskId)}>
                      {storm.openPlan}
                    </Button>
                  ) : null}
                  {canAct && canRedraft ? (
                    <Button
                      variant={data.plan === null || plansReplaced ? 'primary' : 'default'}
                      disabled={redraft.isPending}
                      onClick={() => {
                        redraft.mutate(id, { onError: showError });
                      }}
                    >
                      {redraft.isPending ? storm.redrafting : storm.redraft}
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
        <StormResults results={data.results} running={planStatus === 'running'} />
        {canAct && !confirming ? (
          <div className={styles.footer}>
            <Button
              variant="quiet"
              onClick={() => {
                setConfirming(true);
              }}
            >
              {storm.dismiss}
            </Button>
          </div>
        ) : null}
        {canAct && confirming ? (
          <Panel role="alertdialog" title={storm.dismissConfirmTitle} className={styles.confirm}>
            <p className={styles.line}>{storm.dismissConfirmBody}</p>
            <div className={styles.buttons}>
              <Button
                variant="ink"
                busy={dismiss.isPending}
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
                variant="quiet"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {storm.dismissCancel}
              </Button>
            </div>
          </Panel>
        ) : null}
      </div>
    </AppPage>
  );
}
