import { Button } from '@roofline/ui';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { readScanMs, type ScanSession } from './scan.ts';
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

function Mark() {
  return (
    <span className={styles.mark} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14" focusable="false">
        <path d="M3 10.5 8 5.5l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** The bar over the bottom of the aerial: the invitation to measure, then the scan's progress. Gone once measured. */
export function ScanBar({ scan }: { scan: ScanSession }) {
  if (scan.phase === 'done') return null;
  if (scan.phase === 'idle') {
    return (
      <div className={styles.bar} data-scan="idle">
        <Mark />
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
  const total = readScanMs();
  const share = total === 0 ? 1 : Math.min(scan.elapsedMs / total, 1);
  return (
    <div className={styles.bar} data-scan="scanning" role="status">
      <Mark />
      <div className={styles.progress}>
        <p className={styles.text}>{liftMeasure.scanning(scan.facets, scan.elapsedMs / 1000)}</p>
        <span className={styles.track}>
          <span className={styles.fill} style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      </div>
    </div>
  );
}

/** A band that sweeps across the aerial while the scan plays. */
export function ScanSweep({ scan }: { scan: ScanSession }) {
  if (scan.phase !== 'scanning') return null;
  return <div className={styles.sweep} aria-hidden="true" />;
}
