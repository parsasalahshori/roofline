import styles from './Badge.module.css';

export type BadgeProps = {
  count: number;
  /** What the count means, for example "3 unread messages". It is the badge's accessible name. */
  label: string;
  /** alert (red): a person is needed. neutral (a quiet mono pill): just a number. */
  tone?: 'alert' | 'neutral';
};

const MAX_SHOWN = 99;

/** A count pill. Nothing is drawn at zero; above 99 it reads 99+. Red is only for things that need a person. */
export function Badge({ count, label, tone = 'alert' }: BadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span role="img" aria-label={label} className={styles.badge} data-tone={tone}>
      {count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
    </span>
  );
}
