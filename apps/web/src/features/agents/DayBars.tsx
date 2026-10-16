import type { DayCount } from '@roofline/shared';
import styles from './DayBars.module.css';

/**
 * The last days as bars, oldest first, the newest in the company's colour (the kit's KPI bars, taller). One image for a
 * screen reader: the label and the counts, comma separated. Nothing is drawn for a day with no work but a short stub, so
 * the row keeps its rhythm.
 */
export function DayBars({ days, label }: { days: ReadonlyArray<DayCount>; label: string }) {
  const values = days.map((day) => day.finished);
  const top = Math.max(1, ...values);
  return (
    <span className={styles.bars} role="img" aria-label={`${label}: ${values.join(', ')}`}>
      {values.map((value, index) => (
        <span
          key={days[index]?.date ?? index}
          className={styles.bar}
          data-current={index === values.length - 1 ? 'true' : undefined}
          style={{ height: `${Math.max(8, Math.round((value / top) * 100))}%` }}
        />
      ))}
    </span>
  );
}
