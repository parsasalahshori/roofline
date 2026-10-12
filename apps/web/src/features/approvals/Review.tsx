import { useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, ReviewSteps, Skeleton, StatCard, useToast } from '@roofline/ui';
import { useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { ApiError } from '../../api/client.ts';
import type { StepView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { review } from '../../copy/review.ts';
import { shell } from '../../copy/shell.ts';
import { AGENT_LABEL, taskStatusLabel } from '../../copy/status.ts';
import { AppWindow } from '../../shell/AppWindow.tsx';
import { pathAfterDecline, useApprove, useDecline, useEditStep, useRerun, useRetryStep, useTask } from './api.ts';
import { editableText } from './editable.ts';
import { EditStepSheet } from './EditStepSheet.tsx';
import { NotNowSheet } from './NotNowSheet.tsx';
import { StepFieldsSheet } from './StepFieldsSheet.tsx';
import { POLL_AFTER_APPROVE_MS } from './polling.ts';
import styles from './Review.module.css';
import { kitFor } from './steps/index.ts';
import { reviewMode, seenSteps, toReviewStep } from './toReviewStep.ts';

/** Which window the review screen sits in: the approvals window, or the Storm window (`/storm/plans/:taskId`). */
export type ReviewApp = 'approvals' | 'storm';

/** Where a plan's own address is, per window. A plan run again opens at the same kind of address. */
const PLAN_BASE: Record<ReviewApp, string> = { approvals: '/approvals', storm: '/storm/plans' };

/** The review screen for one plan, in its own window. `app` defaults to `approvals`. */
export function Review({ taskId, app = 'approvals' }: { taskId: string; app?: ReviewApp }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Set when an approval goes through: the plan is asked for again for a while, so its results show up
  const [pollUntil, setPollUntil] = useState(0);
  const task = useTask(taskId, pollUntil);
  const edit = useEditStep(taskId);
  const approve = useApprove(taskId);
  const decline = useDecline(taskId);
  const retry = useRetryStep(taskId);
  const rerun = useRerun(taskId);

  // Steps whose switch is on its way to the server
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const [notNowOpen, setNotNowOpen] = useState(false);
  const [notNowError, setNotNowError] = useState<string | undefined>(undefined);
  // Set at once on a click, before React draws the disabled button, so a fast second click does nothing
  const approvingRef = useRef(false);

  // The plan as last loaded. A failed background refetch must not hide a plan that is already on screen.
  const data = task.data;
  const loadedStep = (stepId: string) => data?.steps.find((item) => item.id === stepId);

  const editingStep = editingId === null ? undefined : loadedStep(editingId);
  const editable = editingStep === undefined ? null : editableText(editingStep);
  // A step type with a review kit is edited through the generic sheet (fields from the kit)
  const kit = editingStep === undefined ? undefined : kitFor(editingStep);

  function showError(error: Error) {
    toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
  }

  function markPending(stepId: string, on: boolean) {
    setPending((current) => {
      const next = new Set(current);
      if (on) next.add(stepId);
      else next.delete(stepId);
      return next;
    });
  }

  function onToggle(stepId: string, enabled: boolean) {
    const step = loadedStep(stepId);
    if (step === undefined) return;
    markPending(stepId, true);
    // mutateAsync, not mutate: a second switch can start before this one answers, and mutate() drops the
    // callbacks of every call it has replaced, which would leave this switch disabled for good
    void edit
      .mutateAsync({ stepId, version: step.version, enabled })
      .catch(showError)
      .finally(() => {
        markPending(stepId, false);
      });
  }

  function onEdit(stepId: string) {
    setEditingId(stepId);
    setEditError(undefined);
  }

  function closeEdit() {
    setEditingId(null);
    setEditError(undefined);
  }

  /** Sends the step's new payload. A 400 keeps the sheet open with the server's sentence; a 409 closes it. */
  function sendEdit(step: StepView, payload: Record<string, unknown>) {
    void edit
      .mutateAsync({ stepId: step.id, version: step.version, payload })
      .then(closeEdit, (error: Error) => {
        if (error instanceof ApiError && error.status === 400) {
          // The sentence belongs on the field, and the sheet stays open so the text can be fixed
          setEditError(error.message);
          return;
        }
        if (error instanceof ApiError && error.status === 409) closeEdit();
        showError(error);
      });
  }

  function saveEdit(text: string) {
    if (editingStep === undefined || editable === null) return;
    sendEdit(editingStep, { ...(editingStep.payload ?? {}), [editable.key]: text });
  }

  function saveKitEdit(payload: Record<string, unknown>) {
    if (editingStep === undefined) return;
    sendEdit(editingStep, payload);
  }

  function onApprove() {
    // A switch still on its way would be approved at the version from before it, so Approve waits for it
    if (data === undefined || approvingRef.current || approve.isPending || pending.size > 0) return;
    approvingRef.current = true;
    approve.mutate(
      { steps: seenSteps(data) },
      {
        onSuccess: () => {
          setPollUntil(Date.now() + POLL_AFTER_APPROVE_MS);
        },
        onError: showError,
        onSettled: () => {
          approvingRef.current = false;
        },
      },
    );
  }

  function openNotNow() {
    setNotNowOpen(true);
    setNotNowError(undefined);
  }

  function closeNotNow() {
    setNotNowOpen(false);
    setNotNowError(undefined);
  }

  function confirmNotNow(reason: string) {
    if (decline.isPending) return;
    decline.mutate(
      { reason },
      {
        onSuccess: () => {
          setNotNowOpen(false);
          toast.show(approvals.declined, 'success');
          void pathAfterDecline(queryClient, taskId).then((to) => {
            void navigate(to);
          });
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 400) {
            setNotNowError(error.message);
            return;
          }
          if (error instanceof ApiError && error.status === 409) setNotNowOpen(false);
          showError(error);
        },
      },
    );
  }

  function onRetry(stepId: string) {
    void retry.mutateAsync({ stepId }).catch(showError);
  }

  function runAgain() {
    if (rerun.isPending) return;
    rerun.mutate(undefined, {
      onSuccess: (next) => {
        void navigate(`${PLAN_BASE[app]}/${encodeURIComponent(next.id)}`);
      },
      onError: showError,
    });
  }

  const stats =
    data === undefined ? undefined : (
      <div className={styles.stats}>
        <StatCard label={review.statAgent} value={AGENT_LABEL[data.agent]} />
        <StatCard label={review.statStatus} value={taskStatusLabel(data)} />
        <StatCard label={review.statDrafted} value={review.drafted(data.createdAt)} />
      </div>
    );

  let body: ReactNode;
  if (data === undefined) {
    if (task.error === null) {
      body = (
        <div className={styles.loading}>
          <p>{review.loading}</p>
          <Skeleton lines={4} />
        </div>
      );
    } else if (task.error instanceof ApiError && task.error.status === 404) {
      body = <EmptyState title={shell.notFoundTitle} action={<Button variant="primary" href="/">{shell.backToMap}</Button>} />;
    } else {
      body = (
        <EmptyState
          title={task.error instanceof ApiError ? task.error.message : errors.generic}
          action={
            <Button variant="primary" onClick={() => void task.refetch()}>
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
  } else if (data.expired) {
    body = (
      <EmptyState
        title={review.expiredTitle}
        action={
          <Button variant="primary" busy={rerun.isPending} onClick={runAgain}>
            {review.runAgain}
          </Button>
        }
      />
    );
  } else {
    const mode = reviewMode(data);
    const ordered = [...data.steps].sort((a, b) => a.position - b.position);
    body = (
      <section className={styles.plan} data-mode={mode}>
        <h2 className={styles.title}>{data.title}</h2>
        {data.summary ? <p className={styles.summary}>{data.summary}</p> : null}
        <ReviewSteps
          mode={mode}
          steps={ordered.map((item) => toReviewStep(item, data))}
          copy={review}
          approving={approve.isPending || pending.size > 0}
          pendingStepIds={pending}
          onToggle={onToggle}
          onEdit={onEdit}
          onRetry={onRetry}
          onApprove={onApprove}
          onNotNow={openNotNow}
        />
        {ordered.map((item) => {
          const itemKit = kitFor(item);
          if (itemKit === undefined) return null;
          return (
            <div className={styles.detail} key={item.id}>
              <itemKit.Preview step={item} canApprove={item.canApprove} />
            </div>
          );
        })}
      </section>
    );
  }

  return (
    <AppWindow app={app} stats={stats}>
      {body}
      {editingStep !== undefined && kit !== undefined ? (
        <StepFieldsSheet
          key={editingStep.id}
          step={editingStep}
          kit={kit}
          saving={edit.isPending}
          error={editError}
          onSave={saveKitEdit}
          onClose={closeEdit}
        />
      ) : editingStep !== undefined && editable !== null ? (
        <EditStepSheet
          key={editingStep.id}
          fieldLabel={review.messageLabel}
          initialText={editable.value}
          saving={edit.isPending}
          error={editError}
          onSave={saveEdit}
          onClose={closeEdit}
        />
      ) : null}
      {notNowOpen ? (
        <NotNowSheet saving={decline.isPending} error={notNowError} onConfirm={confirmNotNow} onClose={closeNotNow} />
      ) : null}
    </AppWindow>
  );
}

/** The route element: reads `:taskId` from the address and shows `Review` for it, keyed by the id. */
export function ReviewRoute({ app }: { app: ReviewApp }) {
  const { taskId } = useParams();
  return <Review key={taskId} taskId={taskId ?? ''} app={app} />;
}
