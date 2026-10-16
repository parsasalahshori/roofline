import { publicCopy } from '../../copy/public.ts';
import styles from './StepProgress.module.css';

/** "Step 2 of 3" with its bars: ink for the steps reached, a hairline for the rest. The bars are decoration; the words say where the person is. */
export function StepProgress({ step, total = 3 }: { step: number; total?: number }) {
  return (
    <div className={styles.progress}>
      <span className={styles.bars} aria-hidden="true">
        {Array.from({ length: total }, (_, index) => (
          <i key={index} data-reached={index < step ? true : undefined} />
        ))}
      </span>
      <span className={styles.label}>{publicCopy.stepOf(step, total)}</span>
    </div>
  );
}
