import { Button, Icon } from '@roofline/ui';
import { liftMeasure } from '../../../copy/liftMeasure.ts';
import { AiMark } from './AiMark.tsx';
import type { ScanTimer } from './scan.ts';
import styles from './ScanBar.module.css';

/**
 * The bar over the bottom of the picture before it is measured: what Estimator does, and the Measure button. The
 * words default to the roof's ("Measure roof"); the windows screen hands in its own.
 */
export function ScanBar({
  scan,
  introName = liftMeasure.scanIntroName,
  introRest = liftMeasure.scanIntroRest,
  button = liftMeasure.scanButton,
}: {
  scan: Pick<ScanTimer, 'phase' | 'start'>;
  introName?: string;
  introRest?: string;
  button?: string;
}) {
  if (scan.phase !== 'idle') return null;
  return (
    <div className={styles.bar} data-scan="idle">
      <AiMark size={22} />
      <p className={styles.text}>
        <strong>{introName}</strong>
        {introRest}
      </p>
      <Button className={styles.measure} onClick={scan.start}>
        <Icon name="ruler" size={18} />
        {button}
      </Button>
    </div>
  );
}
