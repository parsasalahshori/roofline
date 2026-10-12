import { Button, Checkbox, Field, Sheet } from '@roofline/ui';
import { useId, useState, type FormEvent } from 'react';
import { doors } from '../../../copy/doors.ts';
import styles from './WantsCheckSheet.module.css';
import type { DoorLead } from './types.ts';
import { validateLead, type LeadDraft, type LeadErrors } from './validateLead.ts';

const EMPTY: LeadDraft = { name: '', phone: '', email: '', okToText: false, note: '' };

export type WantsCheckSheetProps = {
  open: boolean;
  busy: boolean;
  /** The last save did not go through: the typed values stay and the message shows. */
  failed: boolean;
  onClose: () => void;
  onSubmit: (lead: DoorLead) => void;
};

/** The "Wants a check" sheet. Renders nothing while closed; each opening starts with an empty form. */
export function WantsCheckSheet({ open, busy, failed, onClose, onSubmit }: WantsCheckSheetProps) {
  return (
    <Sheet open={open} title={doors.sheetTitle} onClose={onClose} closeLabel={doors.sheetClose}>
      {open ? <LeadForm busy={busy} failed={failed} onSubmit={onSubmit} /> : null}
    </Sheet>
  );
}

type LeadFormProps = Pick<WantsCheckSheetProps, 'busy' | 'failed' | 'onSubmit'>;

/** Mounted only while the sheet is open, so its state starts fresh each time. */
function LeadForm({ busy, failed, onSubmit }: LeadFormProps) {
  const formId = useId();
  const [draft, setDraft] = useState<LeadDraft>(EMPTY);
  const [errors, setErrors] = useState<LeadErrors>({});

  const set = <K extends keyof LeadDraft>(key: K, value: LeadDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateLead(draft);
    setErrors(result.errors);
    if (result.lead) onSubmit(result.lead);
  };

  return (
    <>
      <form id={formId} className={styles.form} onSubmit={submit} noValidate>
        {failed ? (
          <p role="alert" className={styles.alert}>
            {doors.notSaved}
          </p>
        ) : null}
        <Field
          className={styles.field}
          label={doors.leadName}
          autoComplete="name"
          value={draft.name}
          onChange={(event) => set('name', event.target.value)}
          error={errors.name}
        />
        <Field
          className={styles.field}
          label={doors.leadPhone}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={draft.phone}
          onChange={(event) => set('phone', event.target.value)}
          error={errors.phone ?? errors.contact}
        />
        <Field
          className={styles.field}
          label={doors.leadEmail}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={draft.email}
          onChange={(event) => set('email', event.target.value)}
          error={errors.email}
        />
        <Checkbox
          label={doors.leadOkToText}
          checked={draft.okToText}
          onChange={(next) => set('okToText', next)}
        />
        <Field
          className={styles.field}
          label={doors.leadNote}
          multiline
          value={draft.note}
          onChange={(event) => set('note', event.target.value)}
        />
      </form>
      <Button type="submit" form={formId} size="lg" busy={busy} className={styles.save}>
        {doors.leadSave}
      </Button>
    </>
  );
}
