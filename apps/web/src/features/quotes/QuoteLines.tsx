import { money, type QuoteLine } from '@roofline/shared';
import { Table, Td, Th, Tr } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';

export type QuoteLinesProps = { lines: QuoteLine[] };

/** The priced lines of a quote: item, quantity with its unit, rate and amount, in a table with the numbers in mono at the right. */
export function QuoteLines({ lines }: QuoteLinesProps) {
  return (
    <Table aria-label={quotes.linesLabel}>
      <thead>
        <tr>
          <Th>{quotes.colName}</Th>
          <Th numeric>{quotes.colQuantity}</Th>
          <Th numeric>{quotes.colRate}</Th>
          <Th numeric>{quotes.colAmount}</Th>
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => (
          <Tr key={line.code}>
            <Td>{line.name}</Td>
            <Td numeric>{quotes.quantityWithUnit(line.quantity, line.unit)}</Td>
            <Td numeric>{money(line.unitCents)}</Td>
            <Td numeric>{money(line.totalCents)}</Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}
