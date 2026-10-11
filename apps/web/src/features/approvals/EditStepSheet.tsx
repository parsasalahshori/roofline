import { useState } from 'react';
import { Button, Field, Sheet } from '@roofline/ui';
import { common } from '../../copy/common.ts';
import { review } from '../../copy/review.ts';
import styles from './ApprovalSheets.module.css';

export type EditStepSheetProps = {
  /** The label of the text field. */
  fieldLabel: string;
  /** The text as it is now. The field starts with it. */
  initialText: string;
  /** The save is on its way. */
  saving: boolean;
  /** The server's sentence about the text, shown on the field. */
  error?: string;
  /** The text as it stands in the field. */
  onSave(text: string): void;
  onClose(): void;
};

/** A sheet with one multiline field. The parent mounts it while editing and unmounts it to close it. */
export function EditStepSheet({ fieldLabel, initialText, saving, error, onSave, onClose }: EditStepSheetProps) {
  const [text, setText] = useState(initialText);

  return (
    <Sheet
      open
      title={review.editTitle}
      onClose={onClose}
      closeLabel={common.close}
      footer={
        <div className={styles.footer}>
          <Button variant="ghost" disabled={saving} onClick={onClose}>
            {review.cancel}
          </Button>
          <Button variant="primary" busy={saving} onClick={() => onSave(text)}>
            {review.save}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <Field
          multiline
          rows={6}
          label={fieldLabel}
          value={text}
          error={error}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
    </Sheet>
  );
}
