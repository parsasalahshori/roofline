import { Button } from '@roofline/ui';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { AiMark } from './AiMark.tsx';
import styles from './MeasureCard.module.css';

function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/**
 * The head of a measure card: the AI mark and what the scan is doing with its live seconds while it plays, then the
 * title, "in N seconds" (when `measuredInMs` is given) and Re-measure (when `onRemeasure` is given). Shared by the
 * roof's card and the windows' card.
 */
export function ScanCardHead({
  title,
  scanning,
  elapsedMs,
  measuredInMs = null,
  onRemeasure,
}: {
  title: string;
  scanning: boolean;
  elapsedMs: number;
  measuredInMs?: number | null;
  onRemeasure?: (() => void) | undefined;
}) {
  return (
    <div className={styles.head}>
      <AiMark labelled />
      <h2 className={styles.title} {...(scanning ? { role: 'status' } : {})}>
        {title}
      </h2>
      {scanning ? (
        <span className={styles.timer}>{liftMeasure.seconds(elapsedMs / 1000)}</span>
      ) : (
        <>
          {measuredInMs !== null ? <span className={styles.seconds}>{liftMeasure.measuredIn(measuredInMs / 1000)}</span> : null}
          <span className={styles.spacer} />
          {onRemeasure !== undefined ? (
            <Button variant="ghost" className={styles.headButton} onClick={onRemeasure}>
              <RotateIcon />
              {liftMeasure.remeasure}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
