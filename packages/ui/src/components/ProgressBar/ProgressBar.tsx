import styles from './ProgressBar.module.css';

export type ProgressBarProps = {
  value: number;
  max: number;
  /** What the bar measures, for example "Importing". It is the bar's accessible name and is not drawn. */
  label: string;
};

/** A determinate bar. The value is clamped to 0..max; a max of zero or less draws an empty bar. */
export function ProgressBar({ value, max, label }: ProgressBarProps) {
  const clamped = max > 0 ? Math.min(Math.max(value, 0), max) : 0;
  const percent = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuenow={clamped}
      aria-valuemax={max}
      aria-label={label}
      className={styles.track}
    >
      <div className={styles.fill} style={{ width: `${percent}%` }} />
    </div>
  );
}
