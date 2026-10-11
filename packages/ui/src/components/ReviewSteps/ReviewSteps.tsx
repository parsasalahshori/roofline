import { useId } from 'react';
import type { StepResult, StepStatus } from '@roofline/shared';
import { Button } from '../Button/Button.tsx';
import { Toggle } from '../Toggle/Toggle.tsx';
import { summarizeApproval, type ApprovalSummary, type ReviewStep } from './summarize.ts';
import styles from './ReviewSteps.module.css';

/** Every word the screen shows. The web app writes them (spec 4.7); the kit holds no text. */
export type ReviewStepsCopy = {
  approveButton(s: ApprovalSummary): string;
  nothingOn: string;
  notNow: string;
  footerNoteSpend: string;
  footerNote: string;
  ownerApprovesSpending: string;
  waitingForOwner: string;
  edit: string;
  retry: string;
  switchLabel(title: string): string;
  recipients(count: number): string;
  sendTime(when: string): string;
  spend(cents: number): string;
  stepStatus(status: StepStatus): string;
  resultLines(result: StepResult): string[];
};

export type ReviewStepsProps = {
  /** `review` asks for a decision. `progress` shows what happened after one was made. */
  mode: 'review' | 'progress';
  steps: ReviewStep[];
  copy: ReviewStepsCopy;
  /** The approval is being sent. */
  approving?: boolean;
  /** Steps with a switch change on its way to the server. */
  pendingStepIds?: ReadonlySet<string>;
  onToggle(stepId: string, enabled: boolean): void;
  onEdit?(stepId: string): void;
  onRetry?(stepId: string): void;
  onApprove(): void;
  onNotNow(): void;
};

type RowProps = {
  step: ReviewStep;
  mode: ReviewStepsProps['mode'];
  copy: ReviewStepsCopy;
  pending: boolean;
  onToggle: ReviewStepsProps['onToggle'];
  onEdit: ReviewStepsProps['onEdit'];
  onRetry: ReviewStepsProps['onRetry'];
};

/** A failed step can be tried again; a step that is merely running with a warning cannot. */
const RETRYABLE: ReadonlySet<StepStatus> = new Set<StepStatus>(['failed', 'needs_attention']);

function ReviewRow({ step, mode, copy, pending, onToggle, onEdit, onRetry }: RowProps) {
  const titleId = useId();
  const { preview } = step;
  const reviewing = mode === 'review';
  // In review the status label replaces the live switch on a step that was already decided.
  const showStatus = !reviewing || !step.open;
  const statusLabel =
    !reviewing && step.status === 'awaiting_owner' ? copy.waitingForOwner : copy.stepStatus(step.status);
  const canEdit = reviewing && step.editable && step.open && step.canApprove && onEdit !== undefined;
  const canRetry = !reviewing && RETRYABLE.has(step.status) && step.canApprove && onRetry !== undefined;
  const resultLines = step.result ? copy.resultLines(step.result) : [];

  return (
    <li className={styles.row} data-state={step.enabled ? 'on' : 'off'} data-status={step.status}>
      {reviewing ? (
        <div className={styles.switch}>
          <Toggle
            checked={step.enabled}
            onChange={(next) => onToggle(step.id, next)}
            label={copy.switchLabel(step.title)}
            labelHidden
            disabled={!step.open || pending || !step.canApprove}
          />
        </div>
      ) : null}
      <div className={styles.body}>
        <div className={styles.head}>
          <strong id={titleId} className={styles.title}>
            {step.title}
          </strong>
          {showStatus ? (
            <span className={styles.status} data-status={step.status}>
              {statusLabel}
            </span>
          ) : null}
        </div>

        {preview.messageSample ? (
          <p className={styles.bubble} data-wrap="anywhere">
            {preview.messageSample}
          </p>
        ) : null}
        {preview.recipientCount !== undefined || preview.sendTime || preview.maxSpendCents !== undefined ? (
          <ul className={styles.facts}>
            {preview.recipientCount !== undefined ? <li>{copy.recipients(preview.recipientCount)}</li> : null}
            {preview.sendTime ? <li>{copy.sendTime(preview.sendTime)}</li> : null}
            {preview.maxSpendCents !== undefined ? <li>{copy.spend(preview.maxSpendCents)}</li> : null}
          </ul>
        ) : null}
        {preview.lines.length > 0 ? (
          <ul className={styles.lines}>
            {preview.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}

        {reviewing && step.approvalClass === 'spend' && !step.canApprove ? (
          <p className={styles.note}>{copy.ownerApprovesSpending}</p>
        ) : null}

        {!reviewing && resultLines.length > 0 ? (
          <ul className={styles.results}>
            {resultLines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {!reviewing && step.errorPlain ? <p className={styles.error}>{step.errorPlain}</p> : null}

        {canEdit ? (
          <div className={styles.actions}>
            <Button variant="ghost" aria-describedby={titleId} onClick={() => onEdit(step.id)}>
              {copy.edit}
            </Button>
          </div>
        ) : null}
        {canRetry ? (
          <div className={styles.actions}>
            <Button variant="ghost" aria-describedby={titleId} onClick={() => onRetry(step.id)}>
              {copy.retry}
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** The one review screen every agent's plan uses: what will happen, what it costs, and the OK. */
export function ReviewSteps({
  mode,
  steps,
  copy,
  approving = false,
  pendingStepIds,
  onToggle,
  onEdit,
  onRetry,
  onApprove,
  onNotNow,
}: ReviewStepsProps) {
  const summary = summarizeApproval(steps);
  const nothingOn = summary.count + summary.ownerSteps === 0;
  const spends = steps.some((step) => step.approvalClass === 'spend');

  return (
    <div className={styles.root} data-mode={mode}>
      <ol className={styles.list} role="list">
        {steps.map((step) => (
          <ReviewRow
            key={step.id}
            step={step}
            mode={mode}
            copy={copy}
            pending={pendingStepIds?.has(step.id) ?? false}
            onToggle={onToggle}
            onEdit={onEdit}
            onRetry={onRetry}
          />
        ))}
      </ol>
      {mode === 'review' ? (
        <div className={styles.footer}>
          <p className={styles.footerNote}>{spends ? copy.footerNoteSpend : copy.footerNote}</p>
          <div className={styles.footerActions}>
            <Button variant="ghost" disabled={approving} onClick={onNotNow}>
              {copy.notNow}
            </Button>
            <Button variant="primary" size="lg" busy={approving} disabled={nothingOn} onClick={onApprove}>
              {nothingOn ? copy.nothingOn : copy.approveButton(summary)}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
