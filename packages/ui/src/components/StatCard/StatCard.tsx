import type { ReactNode } from 'react';
import { Card } from '../Card/Card.tsx';
import styles from './StatCard.module.css';

export type StatCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
};

/** One number with its name: a description list of one pair, so a screen reader hears them together. */
export function StatCard({ label, value, hint }: StatCardProps) {
  return (
    <Card>
      <dl className={styles.stat}>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>{value}</dd>
        {hint ? (
          <dd className={styles.hint} data-part="hint">
            {hint}
          </dd>
        ) : null}
      </dl>
    </Card>
  );
}
