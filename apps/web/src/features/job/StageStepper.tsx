import { useState } from 'react';
import type { JobStage, JobView } from '@roofline/shared';
import { Button } from '@roofline/ui';
import { job as copy } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { MoveJobSheet } from '../jobs/MoveJobSheet.tsx';
import { useMoveJob } from '../jobs/api.ts';
import styles from './StageStepper.module.css';

/** The five open stages in pipeline order. Lost is reached through its own button, which opens the sheet. */
const OPEN_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const satisfies readonly JobStage[];

export type StageStepperProps = { job: JobView['job']; canEdit: boolean };

/**
 * The job's stage as a row of buttons. The current stage is highlighted; clicking another moves the
 * job. Won without a value, and Lost, open the sheet that asks for it. Installed is only reachable from Won.
 */
export function StageStepper({ job, canEdit }: StageStepperProps) {
  const move = useMoveJob();
  const [sheet, setSheet] = useState<'lost' | 'won' | null>(null);
  const isLost = job.stage === 'lost';

  async function choose(to: JobStage) {
    if (to === job.stage) return;
    if (to === 'lost') {
      setSheet('lost');
      return;
    }
    if (to === 'won' && (job.valueCents === null || job.valueCents === 0)) {
      setSheet('won');
      return;
    }
    try {
      await move.mutateAsync({ jobId: job.id, to });
    } catch {
      return; // the toast has said why
    }
  }

  return (
    <div className={styles.wrap}>
      <div role="group" aria-label={copy.stepperLabel} className={styles.steps}>
        {OPEN_STAGES.map((stage) => {
          const current = stage === job.stage;
          const blocked = stage === 'installed' && job.stage !== 'won';
          return (
            <Button
              key={stage}
              variant={current ? 'primary' : 'ghost'}
              className={styles.step}
              data-stage={stage}
              data-current={current ? 'true' : 'false'}
              aria-current={current ? 'step' : undefined}
              disabled={!canEdit || blocked || move.isPending}
              onClick={() => void choose(stage)}
            >
              {jobs.stage[stage]}
            </Button>
          );
        })}
        {isLost ? null : (
          <Button
            variant="ghost"
            className={styles.step}
            data-stage="lost"
            disabled={!canEdit || move.isPending}
            onClick={() => void choose('lost')}
          >
            {jobs.stage.lost}
          </Button>
        )}
      </div>
      {isLost ? (
        <div className={styles.lost} data-state="lost">
          <span className={styles.chip}>{copy.lostChip}</span>
          {job.lostReason !== null ? <span className={styles.reason}>{copy.lostWhy(job.lostReason)}</span> : null}
        </div>
      ) : null}
      {sheet !== null ? (
        <MoveJobSheet
          job={job}
          to={sheet}
          onDone={() => {
            setSheet(null);
          }}
        />
      ) : null}
    </div>
  );
}
