import type { ApprovalClass, StepPreview, StepResult, StepStatus } from '@roofline/shared';

/** One step of the review screen, as the web app builds it from the API's task view. */
export type ReviewStep = {
  id: string;
  title: string;
  approvalClass: ApprovalClass;
  status: StepStatus;
  /** Switched on: it will run when the task is approved. */
  enabled: boolean;
  /** This caller may approve it. An office user cannot approve a step that spends money. */
  canApprove: boolean;
  /** Still waiting for this caller's decision. */
  open: boolean;
  preview: StepPreview;
  result: StepResult | null;
  errorPlain: string | null;
  editable: boolean;
};

/** What pressing Approve would do right now. */
export type ApprovalSummary = {
  /** Steps this caller approves: open, switched on, and theirs to approve. */
  count: number;
  /** The most those steps can spend, in cents. */
  maxSpendCents: number;
  /** Steps that are switched on but only the owner can approve. */
  ownerSteps: number;
};

/** Counts only the steps that are open and switched on. */
export function summarizeApproval(steps: ReviewStep[]): ApprovalSummary {
  const summary: ApprovalSummary = { count: 0, maxSpendCents: 0, ownerSteps: 0 };
  for (const step of steps) {
    if (!step.open || !step.enabled) continue;
    if (!step.canApprove) {
      summary.ownerSteps += 1;
      continue;
    }
    summary.count += 1;
    if (step.approvalClass === 'spend') summary.maxSpendCents += step.preview.maxSpendCents ?? 0;
  }
  return summary;
}
