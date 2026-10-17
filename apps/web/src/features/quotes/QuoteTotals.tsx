import { money } from '@roofline/shared';
import { Tag } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';
import styles from './QuoteTotals.module.css';

export type QuoteTotalsProps = {
  subtotalCents: number;
  markupCents: number;
  markupPercent: number;
  taxCents: number;
  totalCents: number;
};

/** The quote's totals under its lines: direct cost, overhead and profit, tax, then the total in Archivo, marked an estimate. */
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
          <span className={styles.total} data-part="total">
            {money(totalCents)}
          </span>
          <Tag>{quotes.estimateLabel}</Tag>
        </dd>
      </div>
    </dl>
  );
}
