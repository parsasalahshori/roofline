import type { GridViewProps } from './types.ts';
import { TimeGrid } from './TimeGrid.tsx';
import styles from './WeekView.module.css';

/** The week view: seven day columns on the shared time grid. */
export function WeekView(props: GridViewProps) {
  return (
    <div className={styles.week}>
      <TimeGrid {...props} />
    </div>
  );
}
