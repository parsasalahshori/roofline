import { Button } from '@roofline/ui';
import { measureGutters } from '../../../copy/measureGutters.ts';
import { measureWindows as copy } from '../../../copy/measureWindows.ts';
import styles from './WindowsWindow.module.css';

type Measured = 'roof' | 'windows' | 'gutters';

/** Roof | Windows | Gutters: the same house, measured for each. Gutters shows only with a roof measurement to work from. */
export function MeasureSwitch({
  current,
  roofHref,
  windowsHref,
  guttersHref = null,
}: {
  current: Measured;
  roofHref: string;
  windowsHref: string;
  guttersHref?: string | null;
}) {
  const item = (which: Measured, href: string, label: string) => (
    <Button
      variant="ghost"
      className={styles.switchItem}
      href={href}
      aria-current={current === which ? 'page' : undefined}
      data-selected={current === which ? 'true' : undefined}
    >
      {label}
    </Button>
  );
  return (
    <nav className={styles.switch} aria-label={copy.switchLabel}>
      {item('roof', roofHref, copy.switchRoof)}
      {item('windows', windowsHref, copy.switchWindows)}
      {guttersHref !== null ? item('gutters', guttersHref, measureGutters.switchGutters) : null}
    </nav>
  );
}
