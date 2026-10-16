import { Button, Field } from '@roofline/ui';
import { useState } from 'react';
import { timeline } from '../../copy/timeline.ts';
import { useAddNote } from './api.ts';
import styles from './NoteComposer.module.css';

export type NoteComposerProps = { subjectType: 'customer' | 'job'; subjectId: string };

/** A note on a job or a customer. Refused (and never sent) when empty or over the limit. */
export function NoteComposer({ subjectType, subjectId }: NoteComposerProps) {
  const [value, setValue] = useState('');
  const subject = subjectType === 'job' ? { jobId: subjectId } : { customerId: subjectId };
  const add = useAddNote(subject);

  const tooLong = value.length > timeline.noteMax;
  const blank = value.trim() === '';
  const error = tooLong ? timeline.noteTooLong : add.isError ? timeline.noteFailed : undefined;

  const submit = () => {
    if (tooLong || blank || add.isPending) return;
    add.mutate(
      { subjectType, subjectId, body: value.trim() },
      { onSuccess: () => setValue('') },
    );
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field
        label={timeline.noteLabel}
        placeholder={timeline.notePlaceholder}
        multiline
        rows={3}
        value={value}
        error={error}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className={styles.footer}>
        <p className={styles.counter} data-over={tooLong ? true : undefined}>
          {timeline.noteCounter(value.length, timeline.noteMax)}
        </p>
        <Button type="submit" variant="default" size="sm" busy={add.isPending} disabled={tooLong || blank}>
          {timeline.noteAdd}
        </Button>
      </div>
    </form>
  );
}
