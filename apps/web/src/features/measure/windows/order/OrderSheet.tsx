import { Button, Checkbox, Field, Panel, Size, Table, Td, Th, Tr } from '@roofline/ui';
import { MAX_LOCATION_LENGTH, MAX_ORDER_QUANTITY, smallestMeasured, type CheckedLine, type WindowOrderLine } from '@roofline/shared';
import type { ReactNode } from 'react';
import { sizeCopy } from '../../../../copy/measureWindows.ts';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { LineStatus, lineSpec, type LineEdit } from './OrderLine.tsx';
import styles from './OrderWindow.module.css';

const SELECTED_TONE = { ready: 'brand', check: 'tape', error: 'bad' } as const;

/** The common frame colours as the spec column's note: "all White / White" when every window has the same, else nothing. */
function sharedColors(lines: readonly WindowOrderLine[]): string | null {
  const first = lines[0];
  if (first === undefined) return null;
  const same = lines.every((l) => l.frameExterior === first.frameExterior && l.frameInterior === first.frameInterior);
  return same ? copy.allColors(copy.colors[first.frameExterior], copy.colors[first.frameInterior]) : null;
}

type Props = {
  lines: readonly WindowOrderLine[];
  checked: readonly CheckedLine[];
  locked: boolean;
  /** The window picked for the panel beside the table. */
  pickedId: string | null;
  onPick: (id: string) => void;
  /** The windows ticked for a change to all of them at once. */
  ticked: ReadonlySet<string>;
  onTick: (id: string, next: boolean) => void;
  onTickAll: (next: boolean) => void;
  /** Shows the change at once and saves it after the pause; `localOnly` shows it without saving (a half-typed number). */
  onEdit: (id: string, edit: LineEdit, localOnly?: boolean) => void;
  /** Beside the title: bringing in new photo windows. */
  actions?: ReactNode;
  /** Over the table: the bar that changes the ticked windows. */
  bar?: ReactNode;
  /** Under the table: the counts and the actions. */
  foot: ReactNode;
};

/**
 * The order as the factory reads it: one row a window with where it is, what the photos read (the smallest, with its
 * error), the size to order, how it is built, how many and whether it is ready. Location and quantity are typed in
 * the row. A row opens in the panel beside the table; its tint says what it needs: brand for ready, tape yellow for a
 * window to look at, red for a hold.
 */
export function OrderSheet({ lines, checked, locked, pickedId, onPick, ticked, onTick, onTickAll, onEdit, actions, bar, foot }: Props) {
  const allTicked = lines.length > 0 && lines.every((l) => ticked.has(l.id));
  const colors = sharedColors(lines);
  const withColors = colors === null;
  return (
    <Panel title={copy.linesTitle} headingLevel={2} tag={lines.length} actions={actions} padded={false} className={styles.sheet} data-order-sheet="">
      {bar}
      <Table className={styles.table} role="table">
        <caption className="visually-hidden">{copy.tableCaption}</caption>
        <thead role="rowgroup">
          <tr role="row">
            {!locked ? (
              <Th role="columnheader" className={styles.thSelect}>
                <Checkbox checked={allTicked} label={<span className="visually-hidden">{copy.selectAll}</span>} onChange={onTickAll} />
              </Th>
            ) : null}
            <Th role="columnheader" className={styles.thLine}>{copy.columns.line}</Th>
            <Th role="columnheader">{copy.columns.location}</Th>
            <Th role="columnheader" className={styles.thMeasured}>{copy.columns.measured}</Th>
            <Th role="columnheader">{copy.columns.order}</Th>
            <Th role="columnheader" className={styles.thSpec}>
              {copy.columns.spec}
              {colors !== null ? <span className={styles.specNote}>{colors}</span> : null}
            </Th>
            <Th role="columnheader">{copy.columns.quantity}</Th>
            <Th role="columnheader">{copy.columns.status}</Th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {lines.map((line, i) => {
            const c = checked[i]!;
            const n = i + 1;
            const picked = line.id === pickedId;
            const name = line.location.trim() === '' ? copy.windowNumber(n) : line.location;
            const measured = smallestMeasured(line.measured);
            const spec = lineSpec(line, c, withColors);
            return (
              <Tr
                key={line.id}
                {...(picked ? { tone: SELECTED_TONE[c.status] } : {})}
                selected={picked}
                className={styles.row}
                role="row"
                data-line={line.id}
                data-status={c.status}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button, a, input, label, [role="checkbox"]')) return;
                  onPick(line.id);
                }}
              >
                {!locked ? (
                  <Td role="cell" className={styles.cSelect}>
                    <Checkbox checked={ticked.has(line.id)} onChange={(next) => onTick(line.id, next)} label={<span className="visually-hidden">{copy.selectLine(n, name)}</span>} />
                  </Td>
                ) : null}
                <Td role="cell" className={styles.cLine}>
                  <Button variant="ghost" size="sm" className={styles.lineButton} aria-pressed={picked} aria-label={copy.openLine(n, name)} onClick={() => onPick(line.id)}>
                    {copy.lineName(n)}
                  </Button>
                </Td>
                <Td role="cell" className={styles.cLocation}>
                  <Field
                    className={styles.cellField}
                    label={copy.locationFor(n)}
                    labelHidden
                    value={line.location}
                    maxLength={MAX_LOCATION_LENGTH}
                    disabled={locked}
                    onChange={(e) => onEdit(line.id, { location: e.currentTarget.value })}
                  />
                </Td>
                <Td role="cell" className={styles.cMeasured}>
                  {measured === null ? (
                    <span className={styles.muted}>{copy.noSize}</span>
                  ) : (
                    <span className={styles.measuredStack}>
                      <Size w={measured.widthIn} h={measured.heightIn} pm={measured.uncertaintyIn} copy={sizeCopy} data-measured="" />
                      {line.measured.length > 1 ? <span className={styles.muted}>{copy.photosCount(line.measured.length)}</span> : null}
                    </span>
                  )}
                </Td>
                <Td role="cell" className={styles.cOrder}>
                  {c.order === null ? (
                    <span className={styles.muted}>{copy.noSize}</span>
                  ) : (
                    <Size w={c.order.widthIn} h={c.order.heightIn} copy={sizeCopy} data-order-size="" />
                  )}
                </Td>
                <Td role="cell" className={styles.cSpec}>
                  <div className={styles.specList}>
                    <span className={styles.specName} data-unset={line.style === null ? 'true' : undefined}>
                      {spec.name}
                    </span>
                    {spec.rest.map((part) => (
                      <span key={part} className={styles.specPart}>
                        {part}
                      </span>
                    ))}
                  </div>
                </Td>
                <Td role="cell" className={styles.cQty}>
                  <Field
                    className={styles.cellField}
                    label={copy.quantityFor(n)}
                    labelHidden
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={MAX_ORDER_QUANTITY}
                    step={1}
                    value={String(line.quantity)}
                    disabled={locked}
                    onChange={(e) => {
                      const q = Number(e.currentTarget.value);
                      const ok = e.currentTarget.value.trim() !== '' && Number.isInteger(q) && q >= 1 && q <= MAX_ORDER_QUANTITY;
                      onEdit(line.id, { quantity: Number.isFinite(q) ? q : 0 }, !ok);
                    }}
                  />
                </Td>
                <Td role="cell" className={styles.cStatus}>
                  <LineStatus status={c.status} />
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      {foot}
    </Panel>
  );
}
