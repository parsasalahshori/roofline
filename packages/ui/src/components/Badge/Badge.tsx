import styles from './Badge.module.css';

export type BadgeProps = {
  count: number;
  /** What the count means, for example "3 unread messages". It is the badge's accessible name. */
  label: string;
};

const MAX_SHOWN = 99;

/** A count bubble. Nothing is drawn at zero; above 99 it reads 99+. */
export function Badge({ count, label }: BadgeProps) {
  if (!(count > 0)) return null;
  return (
    <span role="img" aria-label={label} className={styles.badge}>
      {count > MAX_SHOWN ? `${MAX_SHOWN}+` : count}
    </span>
  );
}
