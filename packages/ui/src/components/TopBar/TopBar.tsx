import type { ReactNode } from 'react';
import styles from './TopBar.module.css';

export type TopBarProps = {
  start: ReactNode;
  middle?: ReactNode;
  end?: ReactNode;
  /**
   * Compact (phone): the start and end slots keep their own width and the middle slot takes what is left,
   * so a wide middle item shrinks instead of pushing the ends under it.
   */
  compact?: boolean;
};

/** The bar across the top: three slots on a grid, so the middle stays centered whatever the sides hold. */
export function TopBar({ start, middle, end, compact = false }: TopBarProps) {
  return (
    <header className={styles.topBar} data-compact={compact ? 'true' : undefined}>
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
