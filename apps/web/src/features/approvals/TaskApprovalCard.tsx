import { useQueryClient } from '@tanstack/react-query';
import { ApprovalCard, Icon, useToast, type ApprovalAction } from '@roofline/ui';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { apiFetch } from '../../api/client.ts';
import { keys } from '../../api/keys.ts';
import type { StepView, TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AGENT_ICON } from '../agents/agentTheme.ts';
import { useApprove } from './api.ts';
import { cardFacts, openSteps, quickApprovable } from './queue.ts';
import styles from './TaskApprovalCard.module.css';
import { isOpen, seenSteps } from './toReviewStep.ts';
import { errorSentence, isEditable, useNotNowSheet, useStepSheet } from './useSheets.tsx';

/** Where a plan's own review screen is. */
export const reviewHref = (taskId: string): string => '/approvals/' + encodeURIComponent(taskId);

/**
 * One plan waiting for a yes, as the kit's approval card. Approve is a yes right here when the plan has one step to
 * decide (the same request the review screen sends with nothing changed); a plan with several steps opens the review
 * screen instead, where each step has its switch. Edit opens the step's own sheet when one step can be edited, the review
 * screen otherwise. Not now asks for an optional reason. The keys 1, E and H press these three buttons.
 *
 * `href` is where the plan's own screen is: the link a plan with several steps has instead of a yes, where Edit goes when no
 * single step can be edited right here, and where "See progress" goes after a yes. It is the review screen under
 * /approvals unless the page that shows the card keeps its plans elsewhere (Storm: /storm/plans/<id>).
 */
export function TaskApprovalCard({ task, now, href }: { task: TaskView; now: number; href?: string }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const approve = useApprove(task.id);
  const [error, setError] = useState<string | undefined>(undefined);
  // The plan as the server has it now, with each step's payload: the list carries none, and an edit needs it
  const [detail, setDetail] = useState<TaskView | undefined>(undefined);
  const [loadingEdit, setLoadingEdit] = useState(false);
  // Set at once on a click, before React draws the busy button, so a fast second press does nothing
  const approvingRef = useRef(false);

  const fail = (failure: Error) => setError(errorSentence(failure));
  const notNow = useNotNowSheet(task.id, { onError: fail });
  const stepSheet = useStepSheet(task.id, (stepId): StepView | undefined => detail?.steps.find((step) => step.id === stepId), {
    onError: fail,
    // The cost and the steps on the card come from the list: ask for it again
    onSaved: () => void queryClient.invalidateQueries({ queryKey: keys.approvals }),
  });

  const planHref = href ?? reviewHref(task.id);
  const open = openSteps(task);
  const quick = quickApprovable(task);

  function onApprove() {
    if (approvingRef.current || approve.isPending) return;
    approvingRef.current = true;
    setError(undefined);
    // After a yes the card stays busy until the list takes it away: a second press must not send the yes twice
    approve.mutateAsync({ steps: seenSteps(task) }).then(
      () => {
        toast.show(approvals.approved(task.title), 'success', {
          action: { label: approvals.seeProgress, onClick: () => void navigate(planHref) },
        });
      },
      (failure: Error) => {
        approvingRef.current = false;
        setError(errorSentence(failure));
      },
    );
  }

  function onEdit() {
    if (loadingEdit) return;
    setLoadingEdit(true);
    setError(undefined);
    apiFetch<TaskView>('/api/approvals/' + encodeURIComponent(task.id))
      .then((fresh) => {
        queryClient.setQueryData<TaskView>(keys.task(task.id), fresh);
        setDetail(fresh);
        // One step to edit: its sheet opens right here. Several (or none): the review screen is where the steps are
        const editable = fresh.steps.filter((step) => isOpen(step, fresh) && step.canApprove && isEditable(step));
        const only = editable[0];
        if (editable.length === 1 && only !== undefined) stepSheet.open(only.id);
        else void navigate(planHref);
      })
      .catch((failure: Error) => setError(errorSentence(failure)))
      .finally(() => setLoadingEdit(false));
  }

  const approveAction: ApprovalAction = quick
    ? { label: approvals.approve, onClick: onApprove, busy: approve.isPending || approve.isSuccess, keyHint: '1' }
    : {
        label: open.length > 1 ? approvals.reviewSteps(open.length) : approvals.reviewPlan,
        href: planHref,
        keyHint: '1',
        icon: 'arrow',
      };

  return (
    <>
      <ApprovalCard
        className={styles.card}
        agentIcon={AGENT_ICON[task.agent]}
        drafted={approvals.drafted(AGENT_LABEL[task.agent], approvals.ago(task.createdAt, now))}
        tag={task.status === 'awaiting_owner' ? approvals.tagWaitingOwner : approvals.tagNeedsOk}
        title={task.title}
        summary={task.summary ?? undefined}
        facts={cardFacts(task)}
        approve={approveAction}
        edit={{ label: approvals.edit, onClick: onEdit, busy: loadingEdit, keyHint: 'E' }}
        later={{ label: approvals.later, onClick: notNow.open, keyHint: 'H' }}
        meta={approvals.expires(task.expiresAt, now)}
        lockedLabel={approvals.locked}
      />
      {error !== undefined ? (
        <p className={styles.error} role="alert">
          <Icon name="alert" size={16} />
          {error}
        </p>
      ) : null}
      {notNow.sheet}
      {stepSheet.sheet}
    </>
  );
}
