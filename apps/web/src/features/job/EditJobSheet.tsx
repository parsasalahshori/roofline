import { useState } from 'react';
import { JOB_SOURCES, type JobSource, type JobView } from '@roofline/shared';
import { Button, Field, Listbox, Sheet, useToast, type ListboxOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { job } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { useArchiveJob, useUpdateJob, type JobEdit } from './api.ts';
import styles from './EditJobSheet.module.css';

export type EditJobSheetProps = { view: JobView; onClose: () => void };

const NEXT_STEP_MAX = 120;
const sourceOptions: ListboxOption<JobSource>[] = JOB_SOURCES.map((source) => ({ value: source, label: jobs.source[source] }));

/** Dollars typed by a person to cents. Empty is null (no value); anything else that is not a positive amount is 'invalid'. */
function parseDollars(text: string): number | null | 'invalid' {
  const cleaned = text.trim().replace(/^\$/, '');
  if (cleaned === '') return null;
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(cleaned)) return 'invalid';
  const cents = Math.round(Number(cleaned.replace(/,/g, '')) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : 'invalid';
}

/** Cents as the dollars text the field shows: 1425000 is "14250". */
function dollarsText(cents: number | null): string {
  return cents === null ? '' : String(cents / 100);
}

/**
 * Edits the job's value, source and next step, and archives or restores it. Only the fields that
 * changed are sent.
 */
export function EditJobSheet({ view, onClose }: EditJobSheetProps) {
  const { job: current, can } = view;
  const update = useUpdateJob(current.id);
  const archive = useArchiveJob(current.id);
  const toast = useToast();

  const [valueText, setValueText] = useState(() => dollarsText(current.valueCents));
  const [valueError, setValueError] = useState(false);
  const [source, setSource] = useState<JobSource>(current.source);
  const [nextStep, setNextStep] = useState(current.nextStep ?? '');
  const [nextStepOn, setNextStepOn] = useState(current.nextStepOn ?? '');
  const [confirming, setConfirming] = useState(false);

  const nextStepTooLong = nextStep.trim().length > NEXT_STEP_MAX;

  async function save() {
    const edit: JobEdit = {};
    if (can.seeValue) {
      const parsed = parseDollars(valueText);
      if (parsed === 'invalid') {
        setValueError(true);
        return;
      }
      if (parsed !== current.valueCents) edit.valueCents = parsed;
    }
    if (source !== current.source) edit.source = source;
    if (nextStepTooLong) return;
    const stepText = nextStep.trim() === '' ? null : nextStep.trim();
    if (stepText !== (current.nextStep ?? null)) edit.nextStep = stepText;
    const dateText = nextStepOn === '' ? null : nextStepOn;
    if (dateText !== (current.nextStepOn ?? null)) edit.nextStepOn = dateText;

    if (Object.keys(edit).length === 0) {
      onClose();
      return;
    }
    try {
      await update.mutateAsync(edit);
    } catch (error) {
      toast.show(error instanceof ApiError && error.message !== '' ? error.message : job.saveFailed, 'error');
      return;
    }
    toast.show(job.saved, 'success');
    onClose();
  }

  async function confirmArchive() {
    try {
      await archive.mutateAsync(!current.archived);
    } catch (error) {
      toast.show(error instanceof ApiError && error.message !== '' ? error.message : job.archiveFailed, 'error');
      return;
    }
    toast.show(current.archived ? job.restored : job.archived, 'success');
    onClose();
  }

  const footer = (
    <div className={styles.footer}>
      <Button variant="quiet" onClick={onClose}>
        {job.cancel}
      </Button>
      <Button variant="primary" busy={update.isPending} onClick={() => void save()}>
        {job.save}
      </Button>
    </div>
  );

  return (
    <Sheet open title={job.editTitle} onClose={onClose} closeLabel={job.close} footer={footer}>
      <div className={styles.body}>
        {can.seeValue ? (
          <Field
            label={job.valueLabel}
            help={job.valueHelp}
            inputMode="decimal"
            value={valueText}
            error={valueError ? job.valueInvalid : undefined}
            onChange={(event) => {
              setValueText(event.currentTarget.value);
              setValueError(false);
            }}
          />
        ) : null}
        <Listbox label={job.sourceLabel} value={source} options={sourceOptions} onChange={setSource} />
        <Field
          label={job.nextStepFieldLabel}
          help={job.nextStepFieldHelp}
          value={nextStep}
          error={nextStepTooLong ? job.nextStepTooLong : undefined}
          onChange={(event) => setNextStep(event.currentTarget.value)}
        />
        <Field
          type="date"
          label={job.nextStepDateLabel}
          value={nextStepOn}
          onChange={(event) => setNextStepOn(event.currentTarget.value)}
        />

        {can.archive ? (
          <div className={styles.archive}>
            {confirming ? (
              <div className={styles.confirm}>
                <p className={styles.confirmText}>{current.archived ? job.restoreConfirm : job.archiveConfirm}</p>
                <div className={styles.confirmActions}>
                  <Button variant="ink" busy={archive.isPending} onClick={() => void confirmArchive()}>
                    {job.confirm}
                  </Button>
                  <Button variant="default" onClick={() => setConfirming(false)}>
                    {job.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <Button variant="default" onClick={() => setConfirming(true)}>
                {current.archived ? job.restore : job.archive}
              </Button>
            )}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
