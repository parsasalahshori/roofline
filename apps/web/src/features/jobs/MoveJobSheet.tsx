import { useState } from 'react';
import type { JobCard, JobStage } from '@roofline/shared';
import { Button, Field, Select, Sheet } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import { useMoveJob } from './api.ts';
import styles from './MoveJobSheet.module.css';

export type MoveJobSheetProps = { job: JobCard; to: Extract<JobStage, 'lost' | 'won'>; onDone: () => void };

const reasonOptions = [
  { value: '', label: jobs.lostReasonPick },
  ...jobs.lostReasons.map((reason) => ({ value: reason, label: reason })),
];

/** The sheet that asks the one thing a move to Lost or Won needs: why it was lost, or what it was worth. */
export function MoveJobSheet({ job, to, onDone }: MoveJobSheetProps) {
  const move = useMoveJob();
  const [reason, setReason] = useState('');
  const [otherText, setOtherText] = useState('');
  const [value, setValue] = useState(() =>
    job.valueCents !== null && job.valueCents > 0 ? String(job.valueCents / 100) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const isOther = reason === jobs.lostReasonOther;

  async function submit() {
    if (to === 'lost') {
      const lostReason = isOther ? otherText.trim() : reason;
      if (lostReason === '') {
        setError(jobs.needLostReason);
        return;
      }
      try {
        await move.mutateAsync({ jobId: job.id, to: 'lost', lostReason });
      } catch {
        return; // the toast has said why; the sheet stays open
      }
      onDone();
      return;
    }

    const cleaned = value.trim().replace(/^\$/, '');
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(cleaned)) {
      setError(jobs.needValue);
      return;
    }
    const valueCents = Math.round(Number(cleaned.replace(/,/g, '')) * 100);
    if (!Number.isFinite(valueCents) || valueCents <= 0) {
      setError(jobs.needValue);
      return;
    }
    try {
      await move.mutateAsync({ jobId: job.id, to: 'won', valueCents });
    } catch {
      return;
    }
    onDone();
  }

  const footer = (
    <div className={styles.footer}>
      <Button variant="ghost" onClick={onDone}>
        {jobs.cancel}
      </Button>
      <Button busy={move.isPending} onClick={() => void submit()}>
        {jobs.confirm}
      </Button>
    </div>
  );

  return (
    <Sheet open title={to === 'lost' ? jobs.sheetLost : jobs.sheetWon} onClose={onDone} closeLabel={jobs.close} footer={footer}>
      <div className={styles.body}>
        {to === 'lost' ? (
          <>
            <Select
              label={jobs.lostReasonLabel}
              value={reason}
              options={reasonOptions}
              error={error !== null && !isOther ? error : undefined}
              onChange={(next) => {
                setReason(next);
                setError(null);
              }}
            />
            {isOther ? (
              <Field
                label={jobs.lostReasonOtherLabel}
                value={otherText}
                error={error ?? undefined}
                onChange={(event) => {
                  setOtherText(event.currentTarget.value);
                  setError(null);
                }}
              />
            ) : null}
          </>
        ) : (
          <Field
            label={jobs.valueLabel}
            help={jobs.valueHelp}
            inputMode="decimal"
            value={value}
            error={error ?? undefined}
            onChange={(event) => {
              setValue(event.currentTarget.value);
              setError(null);
            }}
          />
        )}
      </div>
    </Sheet>
  );
}
