import type { JobStage } from '@roofline/shared';
import { Tag } from '@roofline/ui';
import { jobs } from '../../copy/jobs.ts';
import styles from './StageTag.module.css';

/** A job's stage as a Tag with the stage's colour dot before its word: never the colour alone. */
export function StageTag({ stage, className }: { stage: JobStage; className?: string }) {
  return (
    <Tag className={className}>
      <span className={styles.dot} data-stage={stage} aria-hidden="true" />
      {jobs.stage[stage]}
    </Tag>
  );
}
