import { useQueryClient } from '@tanstack/react-query';
import { hoursLabel } from '@roofline/shared';
import { Button, EmptyState, Icon, Page, Panel, ReviewSteps, Skeleton, summarizeApproval, Tag, UiLink } from '@roofline/ui';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { review } from '../../copy/review.ts';
import { shell } from '../../copy/shell.ts';
import { AGENT_LABEL, taskStatusLabel } from '../../copy/status.ts';
import { agentSlug } from '../agents/slugs.ts';
import { pathAfterDecline, useApprove, useEditStep, useRerun, useRetryStep, useTask } from './api.ts';
import { InlineError } from './InlineError.tsx';
import { POLL_AFTER_APPROVE_MS } from './polling.ts';
import { ReviewBar, type BarNotice } from './ReviewBar.tsx';
import styles from './Review.module.css';
import { kitFor } from './steps/index.ts';
import { TASK_TAG } from './taskStatus.ts';
import { isOpen, reviewMode, seenSteps, toReviewStep } from './toReviewStep.ts';
import { errorSentence, useNotNowSheet, useStepSheet } from './useSheets.tsx';

/** Which window the review screen sits in: the approvals window, or the Storm window (`/storm/plans/:taskId`). */
export type ReviewApp = 'approvals' | 'storm';

/** Where a plan's own address is, per window. A plan run again opens at the same kind of address. */
const PLAN_BASE: Record<ReviewApp, string> = { approvals: '/approvals', storm: '/storm/plans' };

/** The page above the plan: where the way back leads. */
const PARENT: Record<ReviewApp, { label: string; href: string }> = {
  approvals: { label: WINDOW_COPY.approvals.title, href: '/approvals' },
  storm: { label: WINDOW_COPY.storm.title, href: '/storm' },
};

/** While the plan loads: the shape of the two columns, in the place the real panels will take. */
function ReviewSkeleton() {
  return (
    <div className={styles.layout} role="status" aria-label={review.loading}>
      <div className={styles.main}>
        <Panel as="div" padded>
          <div className={styles.skeleton}>
            <Skeleton width="40%" height="1rem" />
            <Skeleton lines={3} height="0.875rem" />
            <Skeleton width="55%" height="1rem" />
            <Skeleton lines={2} height="0.875rem" />
          </div>
        </Panel>
      </div>
      <div className={styles.side}>
        <Panel as="div" padded>
          <div className={styles.skeleton}>
            <Skeleton lines={3} height="0.875rem" />
          </div>
        </Panel>
      </div>
    </div>
  );
}

/** The review screen for one plan, as a page of its own. `app` defaults to `approvals`. */
export function Review({ taskId, app = 'approvals' }: { taskId: string; app?: ReviewApp }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Set when an approval goes through: the plan is asked for again for a while, so its results show up
  const [pollUntil, setPollUntil] = useState(0);
  const task = useTask(taskId, pollUntil);
  const edit = useEditStep(taskId);
  const approve = useApprove(taskId);
  const retry = useRetryStep(taskId);
  const rerun = useRerun(taskId);

  // Steps whose switch is on its way to the server
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set<string>());
  // What went wrong, next to what it is about: under a step, or over the decision
  const [notice, setNotice] = useState<BarNotice | null>(null);
  const [rowErrors, setRowErrors] = useState<Readonly<Record<string, string>>>({});
  // Set at once on a click, before React draws the disabled button, so a fast second click does nothing
  const approvingRef = useRef(false);

  // The plan as last loaded. A failed background refetch must not hide a plan that is already on screen.
  const data = task.data;
  const loadedStep = (stepId: string) => data?.steps.find((item) => item.id === stepId);

  /** A refusal over the decision. A 409 is not the person's mistake: the plan changed, and the screen has the latest. */
  function fail(error: Error) {
    setNotice({ tone: error instanceof ApiError && error.status === 409 ? 'notice' : 'error', text: errorSentence(error) });
  }

  const stepSheet = useStepSheet(taskId, loadedStep, { onError: fail });
  const notNow = useNotNowSheet(taskId, {
    onDeclined: () => {
      void pathAfterDecline(queryClient, taskId).then((to) => {
        void navigate(to);
      });
    },
    onError: fail,
  });

  function markPending(stepId: string, on: boolean) {
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(stepId);
      else next.delete(stepId);
      return next;
    });
  }

  function clearRowError(stepId: string) {
    setRowErrors((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== stepId)));
  }

  function onToggle(stepId: string, enabled: boolean) {
    const step = loadedStep(stepId);
    if (step === undefined) return;
    setNotice(null);
    clearRowError(stepId);
    markPending(stepId, true);
    // mutateAsync, not mutate: a second switch can start before this one answers, and mutate() drops the
    // callbacks of every call it has replaced, which would leave this switch disabled for good
    void edit
      .mutateAsync({ stepId, version: step.version, enabled })
      .catch((error: Error) => {
        // The refusal's sentence stands under the step whose switch it was; any other failure over the decision
        if (error instanceof ApiError && error.status === 400) setRowErrors((current) => ({ ...current, [stepId]: error.message }));
        else fail(error);
      })
      .finally(() => {
        markPending(stepId, false);
      });
  }

  /** A change made from a step's own preview (a text removed): the same edit as the sheet's, and Approve waits for it. */
  function savePayload(stepId: string, version: number, payload: Record<string, unknown>) {
    setNotice(null);
    markPending(stepId, true);
    void edit
      .mutateAsync({ stepId, version, payload })
      .catch(fail)
      .finally(() => {
        markPending(stepId, false);
      });
  }

  function onApprove() {
    // A switch still on its way would be approved at the version from before it, so Approve waits for it
    if (data === undefined || approvingRef.current || approve.isPending || pending.size > 0) return;
    approvingRef.current = true;
    setNotice(null);
    setRowErrors({});
    approve.mutate(
      { steps: seenSteps(data) },
      {
        onSuccess: () => {
          setPollUntil(Date.now() + POLL_AFTER_APPROVE_MS);
        },
        onError: fail,
        onSettled: () => {
          approvingRef.current = false;
        },
      },
    );
  }

  function onRetry(stepId: string) {
    setNotice(null);
    void retry.mutateAsync({ stepId }).catch(fail);
  }

  function runAgain() {
    if (rerun.isPending) return;
    setNotice(null);
    rerun.mutate(undefined, {
      onSuccess: (next) => {
        void navigate(`${PLAN_BASE[app]}/${encodeURIComponent(next.id)}`);
      },
      onError: fail,
    });
  }

  const parent = PARENT[app];
  let body: ReactNode;
  // A plan with a decision to make keeps the decision on the bottom edge, however short the plan is
  let pinned = false;
  if (data === undefined) {
    if (task.error === null) {
      body = <ReviewSkeleton />;
    } else if (task.error instanceof ApiError && task.error.status === 404) {
      body = (
        <Panel as="div">
          <EmptyState
            title={shell.notFoundTitle}
            action={
              <Button variant="primary" href="/">
                {shell.backHome}
              </Button>
            }
          />
        </Panel>
      );
    } else {
      body = (
        <InlineError
          tag={approvals.errorTag}
          message={task.error instanceof ApiError ? task.error.message : errors.generic}
          retryLabel={errors.tryAgain}
          onRetry={() => void task.refetch()}
        />
      );
    }
  } else if (data.expired) {
    body = (
      <Panel as="div">
        <EmptyState
          title={review.expiredTitle}
          body={review.expiredBody}
          action={
            <Button variant="primary" busy={rerun.isPending} onClick={runAgain}>
              {review.runAgain}
            </Button>
          }
        />
        {notice !== null ? (
          <p className={styles.refusal} role="alert">
            <Icon name="alert" size={16} />
            {notice.text}
          </p>
        ) : null}
      </Panel>
    );
  } else {
    const mode = reviewMode(data);
    const ordered = [...data.steps].sort((a, b) => a.position - b.position);
    const reviewSteps = ordered.map((item) => toReviewStep(item, data));
    const open = reviewSteps.filter((item) => item.open);
    const previews = ordered.flatMap((item) => {
      const kit = kitFor(item);
      return kit === undefined ? [] : [{ item, kit }];
    });
    const live = data.status === 'draft' || data.status === 'awaiting_owner';
    const approving = approve.isPending || pending.size > 0;

    pinned = mode === 'review';
    body = (
      <>
        <div className={styles.layout}>
          <div className={styles.main}>
            <Panel
              title={review.stepsTitle}
              tag={mode === 'review' ? review.stepsOn(open.filter((item) => item.enabled).length, open.length) : undefined}
              padded={false}
            >
              <ReviewSteps
                mode={mode}
                steps={reviewSteps}
                copy={review}
                approving={approving}
                pendingStepIds={pending}
                errors={rowErrors}
                footer={false}
                onToggle={onToggle}
                onEdit={stepSheet.open}
                onRetry={onRetry}
                onApprove={onApprove}
                onNotNow={notNow.open}
              />
            </Panel>
          </div>
          <div className={styles.side}>
            <Panel title={review.aboutTitle}>
              <dl className={styles.facts}>
                <div className={styles.fact}>
                  <dt>{review.statAgent}</dt>
                  <dd>
                    {data.agent === 'system' ? (
                      AGENT_LABEL[data.agent]
                    ) : (
                      <UiLink href={`/agents/${agentSlug(data.agent)}`}>{AGENT_LABEL[data.agent]}</UiLink>
                    )}
                  </dd>
                </div>
                <div className={styles.fact}>
                  <dt>{review.statDrafted}</dt>
                  <dd data-mono="true">{review.drafted(data.createdAt)}</dd>
                </div>
                {live && data.expiresAt !== null ? (
                  <div className={styles.fact}>
                    <dt>{review.statExpires}</dt>
                    <dd data-mono="true">{review.expiresAt(data.expiresAt)}</dd>
                  </div>
                ) : null}
                {data.minutesSaved ? (
                  <div className={styles.fact}>
                    <dt>{review.statSaved}</dt>
                    <dd>{review.saved(hoursLabel(data.minutesSaved))}</dd>
                  </div>
                ) : null}
              </dl>
            </Panel>
            {previews.length > 0 ? (
              <Panel title={review.detailsTitle} padded={false}>
                {previews.map(({ item, kit }) => (
                  <div className={styles.detail} key={item.id}>
                    <kit.Preview
                      step={item}
                      canApprove={item.canApprove}
                      taskId={taskId}
                      {...(mode === 'review' && isOpen(item, data) && !pending.has(item.id) && {
                        onSavePayload: (payload: Record<string, unknown>) => {
                          savePayload(item.id, item.version, payload);
                        },
                      })}
                    />
                  </div>
                ))}
              </Panel>
            ) : null}
          </div>
        </div>
        {mode === 'review' ? (
          <ReviewBar
            summary={summarizeApproval(reviewSteps)}
            spends={reviewSteps.some((item) => item.approvalClass === 'spend')}
            approving={approving}
            notice={notice}
            onApprove={onApprove}
            onNotNow={notNow.open}
          />
        ) : notice !== null ? (
          <p className={styles.refusal} role="alert">
            <Icon name="alert" size={16} />
            {notice.text}
          </p>
        ) : null}
      </>
    );
  }

  const status = data === undefined ? null : TASK_TAG[data.status];
  return (
    <Page
      title={data?.title ?? WINDOW_COPY[app].title}
      subtitle={data?.summary ?? undefined}
      actions={
        data !== undefined && status !== null ? (
          <Tag tone={status.tone} icon={status.icon}>
            {taskStatusLabel(data)}
          </Tag>
        ) : undefined
      }
      crumbs={[parent, { label: data?.title ?? review.crumbFallback }]}
      crumbsLabel={shell.crumbsLabel}
      className={pinned ? styles.pinned : undefined}
    >
      {body}
      {stepSheet.sheet}
      {notNow.sheet}
    </Page>
  );
}

/** The route element: reads `:taskId` from the address and shows `Review` for it, keyed by the id. */
export function ReviewRoute({ app }: { app: ReviewApp }) {
  const { taskId } = useParams();
  return <Review key={taskId} taskId={taskId ?? ''} app={app} />;
}
