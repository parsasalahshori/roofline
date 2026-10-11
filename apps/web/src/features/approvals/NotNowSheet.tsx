import { useState } from 'react';
import { Button, Field, Sheet } from '@roofline/ui';
import { common } from '../../copy/common.ts';
import { review } from '../../copy/review.ts';
import styles from './ApprovalSheets.module.css';

/** The most characters a reason may have (the server's limit). */
export const REASON_MAX = 500;

export type NotNowSheetProps = {
  /** The decline is on its way. */
  saving: boolean;
  /** The server's sentence about the reason, shown on the field. */
  error?: string;
  /** The reason as typed (it may be empty or have spaces around it). */
  onConfirm(reason: string): void;
  onClose(): void;
};

/** A sheet with an optional reason. The parent mounts it while it is open and unmounts it to close it. */
export function NotNowSheet({ saving, error, onConfirm, onClose }: NotNowSheetProps) {
  const [reason, setReason] = useState('');

  return (
    <Sheet
      open
      title={review.notNowTitle}
      onClose={onClose}
      closeLabel={common.close}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {review.cancel}
          </Button>
          <Button variant="primary" busy={saving} onClick={() => onConfirm(reason)}>
            {review.notNow}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <Field
          multiline
          rows={4}
          maxLength={REASON_MAX}
          label={review.reasonLabel}
          help={review.reasonHelp}
          value={reason}
          error={error}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Sheet>
  );
}
