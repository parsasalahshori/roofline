import type { ReviewStep } from '@roofline/ui';
import type { StepView, TaskView } from '../../api/types.ts';
import { editableText } from './editable.ts';

/**
 * Does the caller have a decision to make on this step? A draft's pending step is open to everyone
 * who can see the plan. A plan waiting for the owner only has open steps the caller can approve: an
 * office user's waiting spend step is the owner's to decide, and approveTask answers "already handled".
 */
export function isOpen(step: StepView, task: TaskView): boolean {
  switch (task.status) {
    case 'draft':
      return step.status === 'pending';
    case 'awaiting_owner':
      return step.status === 'awaiting_owner' && step.canApprove;
    default:
      return false;
  }
}

/** The step as the kit's review screen takes it. */
export function toReviewStep(step: StepView, task: TaskView): ReviewStep {
  return {
    id: step.id,
    title: step.preview.title,
    approvalClass: step.approvalClass,
    status: step.status,
    enabled: step.enabled,
    canApprove: step.canApprove,
    open: isOpen(step, task),
    preview: step.preview,
    result: step.result,
    errorPlain: step.errorPlain,
    editable: editableText(step) !== null,
  };
}

/** `review` while the caller has something to decide on a live plan, `progress` otherwise. */
export function reviewMode(task: TaskView): 'review' | 'progress' {
  const live = task.status === 'draft' || task.status === 'awaiting_owner';
  return !task.expired && live && task.steps.some((step) => isOpen(step, task)) ? 'review' : 'progress';
}

/**
 * The `{id, version}` of every step the approve request must list: the ones still waiting for a yes,
 * whoever may decide them. The API answers 409 unless each of them is listed at its current version.
 */
export function seenSteps(task: TaskView): { id: string; version: number }[] {
  return task.steps
    .filter((step) => step.status === 'pending' || step.status === 'awaiting_owner')
    .map((step) => ({ id: step.id, version: step.version }));
}
