import { ApprovalCard, Button, useToast } from '@roofline/ui';
import { useRef, useState } from 'react';
import { ApiError } from '../../api/client.ts';
import type { TaskView } from '../../api/types.ts';
import { approvals } from '../../copy/approvals.ts';
import { errors } from '../../copy/errors.ts';
import { home } from '../../copy/home.ts';
import { liftFeed } from '../../copy/liftFeed.ts';
import { AGENT_LABEL } from '../../copy/status.ts';
import { AGENT_ICON } from '../../shell/agentIcon.ts';
import { useApprove, useDecline } from '../approvals/api.ts';
import { NotNowSheet } from '../approvals/NotNowSheet.tsx';
import { seenSteps } from '../approvals/toReviewStep.ts';
import { approvalFacts, canQuickApprove } from './homeFacts.ts';
import styles from './HomeApproval.module.css';
import { useNow } from './useNow.ts';

const weekdayShort = new Intl.DateTimeFormat('en-US', { weekday: 'short' });

export type HomeApprovalProps = {
  /** The newest plan waiting for a yes. */
  task: TaskView;
  /** How many more are waiting after it: a line under the card points at them. */
  more: number;
  /** Where Review and Edit go: the plan's review screen by default. The Storm page opens the storm's own review. */
  href?: string;
  /** The words on the main button when it opens the review (a longer plan). */
  reviewLabel?: string;
  /** Where the line under the card sends the rest. */
  seeAllHref?: string;
};

/**
 * The plan at the top of the approvals, as a card: who drafted it and when, its title, a few facts, then Approve, Edit
 * and Not now. A plan with one decision approves in one tap; a longer one has Review instead (and no Edit), which opens
 * its review screen, where its steps can be read, changed and switched. Not now asks for an optional reason in the same
 * sheet the review screen uses.
 */
export function HomeApproval({ task, more, href: reviewHref, reviewLabel = home.review, seeAllHref = '/approvals' }: HomeApprovalProps) {
  const toast = useToast();
  const approve = useApprove(task.id);
  const decline = useDecline(task.id);
  const now = useNow();
  const [notNowOpen, setNotNowOpen] = useState(false);
  const [notNowError, setNotNowError] = useState<string | undefined>(undefined);
  // Set at once on a click, so a fast second tap does nothing
  const approving = useRef(false);

  const href = reviewHref ?? '/approvals/' + encodeURIComponent(task.id);
  const agent = AGENT_LABEL[task.agent];
  const quick = canQuickApprove(task);

  function showError(error: Error) {
    toast.show(error instanceof ApiError ? error.message : errors.generic, 'error');
  }

  function onApprove() {
    if (approving.current || approve.isPending) return;
    approving.current = true;
    approve.mutate(
      { steps: seenSteps(task) },
      {
        onSuccess: () => toast.show(home.approved(agent)),
        onError: showError,
        onSettled: () => {
          approving.current = false;
        },
      },
    );
  }

  function onNotNow(reason: string) {
    if (decline.isPending) return;
    setNotNowError(undefined);
    decline.mutate(
      { reason },
      {
        onSuccess: () => {
          setNotNowOpen(false);
          toast.show(approvals.declined);
        },
        onError: (error) => setNotNowError(error instanceof ApiError ? error.message : errors.generic),
      },
    );
  }

  return (
    <div className={styles.wrap}>
      <ApprovalCard
        agentIcon={AGENT_ICON[task.agent]}
        drafted={home.approvalDrafted(agent, liftFeed.ago(task.createdAt, now))}
        tag={home.approvalTag}
        title={task.title}
        facts={approvalFacts(task)}
        approve={quick ? { label: home.approve, onClick: onApprove, busy: approve.isPending } : { label: reviewLabel, href }}
        // A longer plan has one place to read and change it, and that is what Review opens: no second button for it
        {...(quick && { edit: { label: home.edit, href } })}
        later={{ label: home.notNow, onClick: () => setNotNowOpen(true) }}
        meta={task.expiresAt === null ? undefined : home.expires(weekdayShort.format(new Date(task.expiresAt)))}
        lockedLabel={home.approvalLocked}
      />
      {more > 0 ? (
        <p className={styles.more}>
          <span>{home.moreWaiting(more)}</span>
          <Button size="sm" variant="ghost" href={seeAllHref}>
            {home.seeAll}
          </Button>
        </p>
      ) : null}
      {notNowOpen ? (
        <NotNowSheet
          saving={decline.isPending}
          {...(notNowError !== undefined && { error: notNowError })}
          onConfirm={onNotNow}
          onClose={() => {
            setNotNowOpen(false);
            setNotNowError(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
