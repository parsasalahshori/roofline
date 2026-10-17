import { useId } from 'react';
import type { StepResult, StepStatus } from '@roofline/shared';
import { Icon, type IconName } from '../../icons.tsx';
import { Button } from '../Button/Button.tsx';
import { Tag, type TagTone } from '../Tag/Tag.tsx';
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
  /** A sentence under a step, by step id: why its switch did not change. Drawn as an error, next to the step. */
  errors?: Readonly<Record<string, string>>;
  /** Draw the Not now and Approve footer (the default). A screen with its own pinned action bar turns it off. */
  footer?: boolean;
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
  error: string | undefined;
  onToggle: ReviewStepsProps['onToggle'];
  onEdit: ReviewStepsProps['onEdit'];
  onRetry: ReviewStepsProps['onRetry'];
};

/** A failed step can be tried again; a step that is merely running with a warning cannot. */
const RETRYABLE: ReadonlySet<StepStatus> = new Set<StepStatus>(['failed', 'needs_attention']);

/** A status is a glyph and a word, never only a colour. */
const STATUS_TAG: Record<StepStatus, { tone: TagTone; icon: IconName }> = {
  pending: { tone: 'neutral', icon: 'clock' },
  awaiting_owner: { tone: 'tape', icon: 'alert' },
  skipped: { tone: 'neutral', icon: 'minus' },
  queued: { tone: 'info', icon: 'clock' },
  running: { tone: 'info', icon: 'refresh' },
  done: { tone: 'ok', icon: 'check' },
  failed: { tone: 'bad', icon: 'alert' },
  needs_attention: { tone: 'warn', icon: 'alert' },
};

function ReviewRow({ step, mode, copy, pending, error, onToggle, onEdit, onRetry }: RowProps) {
  const titleId = useId();
  const { preview } = step;
  const reviewing = mode === 'review';
  // In review the status replaces the live switch's state on a step that was already decided; a step the
  // person switched off says so in words as well as in the switch.
  const decided = !reviewing || !step.open;
  const left = reviewing && step.open && !step.enabled;
  const shownStatus: StepStatus | null = decided ? step.status : left ? 'skipped' : null;
  const statusLabel =
    shownStatus === null
      ? ''
      : !reviewing && shownStatus === 'awaiting_owner'
        ? copy.waitingForOwner
        : copy.stepStatus(shownStatus);
  const canEdit = reviewing && step.editable && step.open && step.canApprove && onEdit !== undefined;
  const canRetry = !reviewing && RETRYABLE.has(step.status) && step.canApprove && onRetry !== undefined;
  const resultLines = step.result ? copy.resultLines(step.result) : [];
  // "Text 13 customers" already says who: the same words again under the title say nothing new
  const recipientsLine = preview.recipientCount === undefined ? null : copy.recipients(preview.recipientCount);
  const showRecipients = recipientsLine !== null && !step.title.includes(recipientsLine);
  const hasFacts = showRecipients || Boolean(preview.sendTime);
  const compact = step.compact === true;

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
          {preview.maxSpendCents !== undefined || shownStatus !== null ? (
            <span className={styles.aside}>
              {preview.maxSpendCents !== undefined ? <span className={styles.cost}>{copy.spend(preview.maxSpendCents)}</span> : null}
              {shownStatus !== null ? (
                <Tag tone={STATUS_TAG[shownStatus].tone} icon={STATUS_TAG[shownStatus].icon} className={styles.status} data-status={shownStatus}>
                  {statusLabel}
                </Tag>
              ) : null}
            </span>
          ) : null}
        </div>

        {hasFacts ? (
          <ul className={styles.facts}>
            {showRecipients ? <li>{recipientsLine}</li> : null}
            {preview.sendTime ? <li>{copy.sendTime(preview.sendTime)}</li> : null}
          </ul>
        ) : null}
        {!compact && preview.messageSample ? (
          <p className={styles.bubble} data-wrap="anywhere">
            {preview.messageSample}
          </p>
        ) : null}
        {!compact && preview.lines.length > 0 ? (
          <ul className={styles.lines}>
            {preview.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}

        {reviewing && step.approvalClass === 'spend' && !step.canApprove ? (
          <p className={styles.note}>
            <Icon name="lock" size={16} />
            {copy.ownerApprovesSpending}
          </p>
        ) : null}

        {!reviewing && resultLines.length > 0 ? (
          <ul className={styles.results}>
            {resultLines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
        {!reviewing && step.errorPlain ? (
          <p className={styles.error}>
            <Icon name="alert" size={16} />
            {step.errorPlain}
          </p>
        ) : null}
        {error !== undefined ? (
          <p className={styles.error} role="alert">
            <Icon name="alert" size={16} />
            {error}
          </p>
        ) : null}

        {canEdit ? (
          <div className={styles.actions}>
            <Button variant="default" size="sm" aria-describedby={titleId} onClick={() => onEdit(step.id)}>
              {copy.edit}
            </Button>
          </div>
        ) : null}
        {canRetry ? (
          <div className={styles.actions}>
            <Button variant="default" size="sm" aria-describedby={titleId} onClick={() => onRetry(step.id)}>
              <Icon name="refresh" size={16} />
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
  errors,
  footer = true,
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
            error={errors?.[step.id]}
            onToggle={onToggle}
            onEdit={onEdit}
            onRetry={onRetry}
          />
        ))}
      </ol>
      {mode === 'review' && footer ? (
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
