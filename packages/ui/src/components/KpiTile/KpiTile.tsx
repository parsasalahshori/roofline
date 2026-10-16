import type { ReactNode } from 'react';
import { cx } from '../../cx.ts';
import styles from './KpiTile.module.css';

export type KpiTileProps = {
  /** The eyebrow: what is being counted, in mono caps. */
  label: string;
  /** The number, in Archivo. */
  value: ReactNode;
  /** A small word after the number ("in", "calls"). */
  unit?: string;
  /** One line under the number. */
  meta?: ReactNode;
  /** Weekly bars drawn at the right; the last one is this week and is drawn in the company's colour. */
  spark?: ReadonlyArray<number>;
  /** What the bars show, for a screen reader (the bars themselves are decoration). */
  sparkLabel?: string;
  className?: string;
};

/** One number with its name: a description list of one pair, so a screen reader hears them together. */
export function KpiTile({ label, value, unit, meta, spark, sparkLabel, className }: KpiTileProps) {
  const top = spark && spark.length > 0 ? Math.max(...spark, 1) : 1;
  return (
    <div className={cx(styles.tile, className)}>
      <dl className={styles.stat}>
        <dt className={styles.label}>{label}</dt>
        <dd className={styles.value}>
          {value}
          {unit ? <span className={styles.unit}>{unit}</span> : null}
        </dd>
        {meta ? (
          <dd className={styles.meta} data-part="hint">
            {meta}
          </dd>
        ) : null}
      </dl>
      {spark && spark.length > 0 ? (
        <span className={styles.spark} role={sparkLabel ? 'img' : undefined} aria-label={sparkLabel} aria-hidden={sparkLabel ? undefined : true}>
          {spark.map((height, index) => (
            <span
              key={index}
              className={styles.bar}
              data-current={index === spark.length - 1 ? 'true' : undefined}
              style={{ height: `${Math.max(8, Math.round((height / top) * 100))}%` }}
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
