import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cx } from '../../cx.ts';
import styles from './Table.module.css';

export type TableProps = Omit<HTMLAttributes<HTMLTableElement>, 'children'> & {
  children: ReactNode;
  /**
   * Names the table's scrolling region. A table wider than its panel scrolls sideways inside that region, and a region
   * that scrolls must be reachable by keyboard, so it is focusable and needs a name.
   */
  regionLabel?: string;
};

/**
 * A table in the kit's style: mono caps heads, 11px rows, hairlines, every fifth row on a stronger rule so a long
 * column of numbers can be followed across. Put <Th>, <Td> and <Tr> inside it, with the usual thead and tbody.
 */
export function Table({ children, regionLabel, className, ...rest }: TableProps) {
  const table = (
    <table {...rest} className={cx(styles.table, className)}>
      {children}
    </table>
  );
  if (!regionLabel) return <div className={styles.wrap}>{table}</div>;
  return (
    <div className={styles.wrap} role="region" aria-label={regionLabel} tabIndex={0}>
      {table}
    </div>
  );
}

/** A column head. `numeric` right-aligns it over its numbers. */
export function Th({ numeric = false, className, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <th scope="col" {...rest} className={cx(styles.th, className)} data-numeric={numeric ? 'true' : undefined} />;
}

/** A cell. `numeric` right-aligns it in tabular mono, for money, sizes and counts. */
export function Td({ numeric = false, className, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td {...rest} className={cx(styles.td, className)} data-numeric={numeric ? 'true' : undefined} />;
}

export type TrProps = HTMLAttributes<HTMLTableRowElement> & {
  /** Tints the row: tape for the one being measured, bad for a hold. The reason is always written in the row too. */
  tone?: 'tape' | 'bad' | 'brand';
  selected?: boolean;
};

export function Tr({ tone, selected = false, className, ...rest }: TrProps) {
  return <tr {...rest} className={cx(styles.tr, className)} data-tone={tone} aria-selected={selected || undefined} data-selected={selected ? 'true' : undefined} />;
}
