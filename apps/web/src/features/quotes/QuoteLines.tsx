import { money, type QuoteLine } from '@roofline/shared';
import { quotes } from '../../copy/quotes.ts';
import styles from './QuoteLines.module.css';

export type QuoteLinesProps = { lines: QuoteLine[] };

/** The priced lines of a quote: item, quantity with its unit, rate and amount, numbers right-aligned. */
export function QuoteLines({ lines }: QuoteLinesProps) {
  return (
    <table className={styles.table} aria-label={quotes.linesLabel}>
      <thead>
        <tr>
          <th scope="col">{quotes.colName}</th>
          <th scope="col" className={styles.num}>
            {quotes.colQuantity}
          </th>
          <th scope="col" className={styles.num}>
            {quotes.colRate}
          </th>
          <th scope="col" className={styles.num}>
            {quotes.colAmount}
          </th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <tr key={line.code}>
            <td className={styles.name}>{line.name}</td>
            <td className={styles.num}>{quotes.quantityWithUnit(line.quantity, line.unit)}</td>
            <td className={styles.num}>{money(line.unitCents)}</td>
            <td className={styles.num}>{money(line.totalCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
