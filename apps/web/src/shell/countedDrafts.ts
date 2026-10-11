import type { ApprovalsList, TaskView } from '../api/types.ts';

/**
 * The drafts that count as "waiting for your OK": status draft or awaiting_owner, and not expired.
 * The top bar's pill, the dock's badges and the Storm window all count the same way.
 */
export function countedDrafts(list: ApprovalsList | undefined): TaskView[] {
  return (list?.tasks ?? []).filter(
    (task) => (task.status === 'draft' || task.status === 'awaiting_owner') && !task.expired,
  );
}
