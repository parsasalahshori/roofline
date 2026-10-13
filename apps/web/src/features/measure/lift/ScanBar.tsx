import { Button } from '@roofline/ui';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { AiMark } from './AiMark.tsx';
import type { ScanSession } from './scan.ts';
import styles from './ScanBar.module.css';

function MeasureIcon() {
  return (
    <svg className={styles.buttonIcon} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5M5 8h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The bar over the bottom of the photo before the roof is measured: what Estimator does, and "Measure roof". */
export function ScanBar({ scan }: { scan: ScanSession }) {
  if (scan.phase !== 'idle') return null;
  return (
    <div className={styles.bar} data-scan="idle">
      <AiMark size={22} />
      <p className={styles.text}>
        <strong>{liftMeasure.scanIntroName}</strong>
        {liftMeasure.scanIntroRest}
      </p>
      <Button className={styles.measure} onClick={scan.start}>
        <MeasureIcon />
        {liftMeasure.scanButton}
      </Button>
    </div>
  );
}
