import type { GridViewProps } from './types.ts';
import { TimeGrid } from './TimeGrid.tsx';
import styles from './DayView.module.css';

/** The day view: one day column on the shared time grid. */
export function DayView(props: GridViewProps) {
  return (
    <div className={styles.day}>
      <TimeGrid {...props} />
    </div>
  );
}
