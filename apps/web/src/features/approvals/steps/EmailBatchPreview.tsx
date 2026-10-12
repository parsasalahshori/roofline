import { missingStormTokens } from '@roofline/shared';
import { stepEmail } from '../../../copy/stepEmail.ts';
import type { StepView } from '../../../api/types.ts';
import styles from './EmailBatchPreview.module.css';
import { payloadOf, textOf } from './payload.ts';
import type { EditFieldSpec, EditValues, StepKit, StepPreviewProps } from './types.ts';


function customerCount(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** The storm email under a send_email_batch step: the subject, what one customer reads, and who gets it. */
export function EmailBatchPreview({ step }: StepPreviewProps) {
  const payload = payloadOf(step);
  const preview = step.preview;
  const subject = textOf(payload.subject) || preview?.title || '';
  const sample = preview?.messageSample ?? '';
  const count = preview?.recipientCount ?? customerCount(payload.customerIds);
  const lines = preview?.lines ?? [];

  return (
    <div className={styles.preview}>
      <h3 className={styles.subject}>{subject}</h3>
      <p className={styles.count}>{stepEmail.recipientsLine(count)}</p>
      {lines.length > 0 ? (
        <ul className={styles.lines}>
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      {sample !== '' ? (
        <div className={styles.sample}>
          <p className={styles.sampleLabel}>{stepEmail.sampleLabel}</p>
          <p className={styles.caption}>{stepEmail.hailCaption}</p>
          <p className={styles.sampleBody}>{sample}</p>
        </div>
      ) : null}
    </div>
  );
}

function editFields(step: StepView): EditFieldSpec[] {
  const payload = payloadOf(step);
  return [
    { id: 'subject', label: stepEmail.subjectLabel, kind: 'text', value: textOf(payload.subject) },
    {
      id: 'body',
      label: stepEmail.bodyLabel,
      kind: 'multiline',
      value: textOf(payload.body),
      help: stepEmail.tokensHelp,
    },
  ];
}

function toPayload(step: StepView, values: EditValues): Record<string, unknown> {
  return {
    ...payloadOf(step),
    subject: String(values.subject ?? ''),
    body: String(values.body ?? ''),
  };
}

function warnings(_step: StepView, values: EditValues): Record<string, string[]> {
  const missing = missingStormTokens(String(values.body ?? ''), 'email');
  return missing.length === 0 ? {} : { body: missing.map((token) => stepEmail.missingToken(token)) };
}

export const emailBatchKit: StepKit = {
  Preview: EmailBatchPreview,
  review: (step) => ({ ...step.preview }),
  editFields,
  toPayload,
  warnings,
};
