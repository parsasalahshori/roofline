import { useState } from 'react';
import type { JobCard, JobStage } from '@roofline/shared';
import { Select, type SelectOption } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import { useMoveJob } from './api.ts';
import { MoveJobSheet } from './MoveJobSheet.tsx';
import styles from './MoveJobMenu.module.css';

export type MoveJobMenuProps = { job: JobCard; onMoved?: () => void; compact?: boolean };

/** The stages in pipeline order. Installed is only offered from Won (Decision 2). */
const STAGE_ORDER: readonly JobStage[] = ['lead', 'inspection', 'proposal', 'won', 'installed', 'lost'];

/** A "Move to" select: the other stages, opening the sheet for Lost, or for Won without a value. */
export function MoveJobMenu({ job, onMoved, compact = false }: MoveJobMenuProps) {
  const move = useMoveJob();
  const [sheetTo, setSheetTo] = useState<'lost' | 'won' | null>(null);

  const options: SelectOption[] = [
    { value: '', label: jobs.moveTo },
    ...STAGE_ORDER.filter((stage) => stage !== job.stage && (stage !== 'installed' || job.stage === 'won')).map(
      (stage) => ({ value: stage, label: jobs.stage[stage] }),
    ),
  ];

  async function choose(to: string) {
    if (to === 'lost') {
      setSheetTo('lost');
      return;
    }
    if (to === 'won' && (job.valueCents === null || job.valueCents === 0)) {
      setSheetTo('won');
      return;
    }
    try {
      await move.mutateAsync({ jobId: job.id, to: to as JobStage });
    } catch {
      return; // the toast has said why
    }
    onMoved?.();
  }

  return (
    <>
      <Select
        label={jobs.moveTo}
        value=""
        options={options}
        className={compact ? styles.compact : undefined}
        onChange={(to) => {
          if (to !== '') void choose(to);
        }}
      />
      {sheetTo !== null ? (
        <MoveJobSheet
          job={job}
          to={sheetTo}
          onDone={() => {
            setSheetTo(null);
            onMoved?.();
          }}
        />
      ) : null}
    </>
  );
}
