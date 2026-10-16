import { cx } from '../../cx.ts';
import styles from './PrecisionLadder.module.css';

/** estimate (a count, about plus or minus 2: a quote only), quote (about 1 inch: a quote you can stand behind), order (an eighth: a factory order). */
export type RungKey = 'estimate' | 'quote' | 'order';

export type LadderRung = {
  key: RungKey;
  label: string;
  /** What this grade is good for and how close it is: "±2 · quote only". */
  note: string;
  /** Windows (or roofs) measured to this grade. */
  count: number;
};

export type PrecisionLadderProps = {
  /** The list's accessible name. */
  label: string;
  /** Always the three rungs, lowest first. */
  rungs: readonly [LadderRung, LadderRung, LadderRung];
  /** What the bars are shares of. Left out, the sum of the counts. */
  total?: number;
  /** Written beside each count: "of 7". */
  ofLabel: (total: number) => string;
  /**
   * stack: one rung to a row (a card, a sidebar). strip: the three rungs side by side under a drawing or a table, each
   * a column with a hairline between; on a phone the strip becomes three small tiles (name over count).
   */
  layout?: 'stack' | 'strip';
  className?: string;
};

/**
 * Three rungs under every measure result: Estimate, Quote-grade and Order-grade, each with its dot, its name, how
 * many windows are at that grade and a bar of the share. The proposal and the order sheet read their state from it. The
 * top rung is green: only an order-grade size can go to a factory.
 */
export function PrecisionLadder({ label, rungs, total, ofLabel, layout = 'stack', className }: PrecisionLadderProps) {
  const sum = total ?? rungs.reduce((acc, rung) => acc + rung.count, 0);
  const share = (count: number) => (sum > 0 ? Math.min(100, Math.round((count / sum) * 100)) : 0);
  return (
    <ol aria-label={label} className={cx(styles.ladder, className)} data-layout={layout}>
      {rungs.map((rung) => (
        <li key={rung.key} className={styles.rung} data-rung={rung.key} data-filled={rung.count > 0 ? 'true' : undefined}>
          <span className={styles.dot} aria-hidden="true" />
          <div className={styles.text}>
            <span className={styles.name}>{rung.label}</span>
            <span className={styles.note}>{rung.note}</span>
          </div>
          <span className={styles.count}>
            {rung.count}
            <span className={styles.of}>{ofLabel(sum)}</span>
          </span>
          <span className={styles.track} aria-hidden="true">
            <span className={styles.bar} style={{ width: `${share(rung.count)}%` }} />
          </span>
        </li>
      ))}
    </ol>
  );
}
