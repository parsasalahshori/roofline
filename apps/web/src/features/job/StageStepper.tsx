import { useState } from 'react';
import type { JobStage, JobView } from '@roofline/shared';
import { Button, Tag } from '@roofline/ui';
import { job as copy } from '../../copy/job.ts';
import { jobs } from '../../copy/jobs.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { MoveJobSheet } from '../jobs/MoveJobSheet.tsx';
import { useMoveJob } from '../jobs/api.ts';
import styles from './StageStepper.module.css';

/** The five open stages in pipeline order. Lost is reached through its own button, which opens the sheet. */
const OPEN_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const satisfies readonly JobStage[];

export type StageStepperProps = { job: JobView['job']; canEdit: boolean };

/**
 * The job's stage as five segments, each a bar over its name: the stages behind it dark, the one it is in drawn in that
 * stage's colour with the days it has been there, the ones ahead pale. A name is a button: it moves the job there. Won
 * without a value, and Lost, open the sheet that asks for it. Installed is only reachable from Won. A phone has no Lost
 * button here: the stage menu in its bar has it, with the L key.
 */
export function StageStepper({ job, canEdit }: StageStepperProps) {
  const move = useMoveJob();
  const phone = useIsPhone();
  const [sheet, setSheet] = useState<'lost' | 'won' | null>(null);
  const isLost = job.stage === 'lost';
  const currentIndex = (OPEN_STAGES as readonly JobStage[]).indexOf(job.stage);

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
        {OPEN_STAGES.map((stage, index) => {
          const current = stage === job.stage;
          const state = current ? 'current' : currentIndex > index ? 'done' : 'todo';
          const blocked = stage === 'installed' && job.stage !== 'won';
          // On a phone Inspection is written short; the button is still named in full
          const short = phone ? copy.stageShort[stage] : undefined;
          return (
            <div key={stage} className={styles.segment} data-state={state} data-step={stage}>
              <span className={styles.bar} aria-hidden="true" />
              <div className={styles.label}>
                <Button
                  variant="ghost"
                  className={styles.step}
                  data-stage={stage}
                  data-current={current ? 'true' : 'false'}
                  aria-current={current ? 'step' : undefined}
                  aria-label={short !== undefined ? jobs.stage[stage] : undefined}
                  disabled={!canEdit || blocked || move.isPending}
                  onClick={() => void choose(stage)}
                >
                  {short ?? jobs.stage[stage]}
                </Button>
                {current ? <span className={styles.days}>{copy.daysInStage(job.daysInStage)}</span> : null}
              </div>
            </div>
          );
        })}
        {isLost || phone ? null : (
          <Button
            variant="ghost"
            className={styles.lostButton}
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
          <Tag icon="x">{copy.lostChip}</Tag>
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

/** The steps while the job loads: five bars in the sunken colour. Decoration only. */
export function StageStepperSkeleton() {
  return (
    <div className={styles.steps} aria-hidden="true">
      {OPEN_STAGES.map((stage) => (
        <div key={stage} className={styles.segment} data-state="todo" data-step={stage}>
          <span className={styles.bar} />
          <span className={styles.skeletonLabel} />
        </div>
      ))}
    </div>
  );
}

