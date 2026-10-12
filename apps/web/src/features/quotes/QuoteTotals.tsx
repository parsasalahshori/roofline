import { money } from '@roofline/shared';
import { quotes } from '../../copy/quotes.ts';
import styles from './QuoteTotals.module.css';

export type QuoteTotalsProps = {
  subtotalCents: number;
  markupCents: number;
  markupPercent: number;
  taxCents: number;
  totalCents: number;
};

/** The quote's totals: direct cost, overhead and profit, tax, then the emphasised total marked as an estimate. */
export function QuoteTotals({ subtotalCents, markupCents, markupPercent, taxCents, totalCents }: QuoteTotalsProps) {
  return (
    <dl className={styles.totals} aria-label={quotes.totalsLabel}>
      <div className={styles.row}>
        <dt>{quotes.directCost}</dt>
        <dd className={styles.num}>{money(subtotalCents)}</dd>
      </div>
      <div className={styles.row}>
        <dt>{quotes.overheadProfit(markupPercent)}</dt>
        <dd className={styles.num}>{money(markupCents)}</dd>
      </div>
      <div className={styles.row}>
        <dt>{quotes.taxLine}</dt>
        <dd className={styles.num}>{money(taxCents)}</dd>
      </div>
      <div className={`${styles.row} ${styles.grand}`}>
        <dt>{quotes.total}</dt>
        <dd className={styles.grandValue}>
          <span className={styles.num} data-part="total">
            {money(totalCents)}
          </span>
          <span className={styles.caption}>{quotes.estimateLabel}</span>
        </dd>
      </div>
    </dl>
  );
}
