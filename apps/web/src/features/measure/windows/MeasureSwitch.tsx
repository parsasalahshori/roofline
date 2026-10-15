import { Button } from '@roofline/ui';
import { measureWindows as copy } from '../../../copy/measureWindows.ts';
import styles from './WindowsWindow.module.css';

/** Roof | Windows: the same house, measured for either. */
export function MeasureSwitch({ current, roofHref, windowsHref }: { current: 'roof' | 'windows'; roofHref: string; windowsHref: string }) {
  return (
    <nav className={styles.switch} aria-label={copy.switchLabel}>
      <Button variant="ghost" className={styles.switchItem} href={roofHref} aria-current={current === 'roof' ? 'page' : undefined} data-selected={current === 'roof' ? 'true' : undefined}>
        {copy.switchRoof}
      </Button>
      <Button variant="ghost" className={styles.switchItem} href={windowsHref} aria-current={current === 'windows' ? 'page' : undefined} data-selected={current === 'windows' ? 'true' : undefined}>
        {copy.switchWindows}
      </Button>
    </nav>
  );
}

