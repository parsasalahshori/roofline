import styles from './ProgressRing.module.css';

export type ProgressRingProps = {
  done: number;
  total: number;
  /** What the ring shows, for example "2 of 5 setup steps done". It is the accessible name; the ring draws no text. */
  label: string;
  size?: 24 | 32;
};

const STROKE = 3;

/** A small ring showing done out of total. It turns the success colour once everything is done. */
export function ProgressRing({ done, total, label, size = 24 }: ProgressRingProps) {
  const complete = done >= total;
  const fraction = total > 0 ? Math.min(Math.max(done / total, 0), 1) : 0;
  const r = (size - STROKE) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      data-complete={complete ? '' : undefined}
      className={styles.ring}
    >
      <circle
        className={styles.track}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        strokeWidth={STROKE}
      />
      <circle
        className={styles.arc}
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        transform={`rotate(-90 ${cx} ${cy})`}
      />
    </svg>
  );
}
