import { money, type QuoteLine } from '@roofline/shared';
import { Table, Td, Th, Tr } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import styles from './QuoteLines.module.css';

export type QuoteLinesProps = { lines: QuoteLine[] };

/**
 * The priced lines of a quote in a table with the numbers in mono at the right: item, quantity with its unit, rate and
 * amount. A phone has no room for four columns, so the quantity and the rate go under the item's name and the amount
 * keeps the right edge.
 */
export function QuoteLines({ lines }: QuoteLinesProps) {
  const phone = useIsPhone();
  return (
    <Table aria-label={quotes.linesLabel}>
      <thead>
        <tr>
          <Th>{quotes.colName}</Th>
          {phone ? null : <Th numeric>{quotes.colQuantity}</Th>}
          {phone ? null : <Th numeric>{quotes.colRate}</Th>}
          <Th numeric>{quotes.colAmount}</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <Tr key={line.code}>
            <Td>
              {line.name}
              {phone ? <span className={styles.detail}>{quotes.lineDetail(quotes.quantityWithUnit(line.quantity, line.unit), money(line.unitCents))}</span> : null}
            </Td>
            {phone ? null : <Td numeric>{quotes.quantityWithUnit(line.quantity, line.unit)}</Td>}
            {phone ? null : <Td numeric>{money(line.unitCents)}</Td>}
            <Td numeric>{money(line.totalCents)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
