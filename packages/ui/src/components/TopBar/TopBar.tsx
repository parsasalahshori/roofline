import type { ReactNode } from 'react';
import styles from './TopBar.module.css';

export type TopBarProps = {
  start: ReactNode;
  middle?: ReactNode;
  end?: ReactNode;
};

/** The bar across the top: three slots on a grid, so the middle stays centered whatever the sides hold. */
export function TopBar({ start, middle, end }: TopBarProps) {
  return (
    <header className={styles.topBar}>
      <div className={styles.start} data-slot="start">
        {start}
      </div>
      <div className={styles.middle} data-slot="middle">
        {middle}
      </div>
      <div className={styles.end} data-slot="end">
        {end}
      </div>
    </header>
  );
}
