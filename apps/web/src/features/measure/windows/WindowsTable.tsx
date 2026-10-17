import { Button, Checkbox, Icon, Size, Table, Tag, Td, Th, Tr, type IconName, type TagTone } from '@roofline/ui';
import { DEFAULT_STYLE_TILES, fractionInches, tileOfStyle, WINDOW_SIZE_CLASSES, type StyleTile, type WindowSizeClass } from '@roofline/shared';
import { Fragment, useId, type ReactNode } from 'react';
import { measureWindows as copy, sizeCopy, windowPhotos } from '../../../copy/measureWindows.ts';
import { toEighth, toSixteenthUp, type RowMethod, type RowReason, type RowStatus, type WindowRow } from './rows.ts';
import styles from './WindowsTable.module.css';

/** The kit's readout names four methods; the table has eight, so it draws the glyph and the name itself. */
const METHOD_ICON: Record<RowMethod, IconName> = { lidar: 'lidar', ar: 'lidar', sheet: 'sheet', paper: 'sheet', hand: 'ruler', room: 'cube', street: 'camera', walls: 'home' };

const STATUS: Record<RowStatus, { tone: TagTone; icon?: IconName }> = {
  ready: { tone: 'ok', icon: 'check' },
  remeasure: { tone: 'warn', icon: 'alert' },
  quote: { tone: 'info', icon: 'target' },
  estimate: { tone: 'neutral' },
  out: { tone: 'neutral', icon: 'x' },
};

function reasonText(reason: RowReason): string {
  if (reason.kind === 'unclear') return copy.table.reasonUnclear;
  if (reason.kind === 'doubt') return copy.table.reasonDoubt(fractionInches(reason.inches));
  return windowPhotos.spread(fractionInches(reason.inches));
}

/** One size class's estimated count: the name and its range in united inches, one fewer, the count, one more. */
function CountStepper({ cls, value, estimate, onChange }: { cls: WindowSizeClass; value: number; estimate: number; onChange: (next: number) => void }) {
  const name = copy.sizeClass[cls];
  return (
    <div className={styles.stepper} data-stepper={cls}>
      <span className={styles.stepperName}>
        {name}
        <span className={styles.stepperHint}>{copy.sizeClassHint[cls]}</span>
      </span>
      <Button variant="default" size="sm" className={styles.step} aria-label={copy.stepDown(name)} disabled={value <= 0} onClick={() => onChange(value - 1)}>
        {copy.minus}
      </Button>
      <output className={styles.count} aria-label={copy.stepValue(name)} data-changed={value !== estimate ? 'true' : undefined}>
        {value}
      </output>
      <Button variant="default" size="sm" className={styles.step} aria-label={copy.stepUp(name)} onClick={() => onChange(value + 1)}>
        {copy.plus}
      </Button>
    </div>
  );
}

export type TableActions = {
  /** Opens a photographed window on its photo to measure it again. */
  onMeasureAgain: (row: WindowRow) => void;
  /** Leaves windows out of the quote, or puts them back. */
  onToggle: (ids: string[]) => void;
  onDelete: (ids: string[]) => void;
  /** "Add on-site photos": the capture step of the photo flow. */
  onAddPhotos: () => void;
  /** The estimated counts: what the quote has now, what the estimate said, and the way to change them. */
  estimated: { value: (cls: WindowSizeClass) => number; estimate: (cls: WindowSizeClass) => number; set: (cls: WindowSizeClass, next: number) => void; changed: boolean; reset: () => void };
  coverAll: boolean;
  onCoverAll: (next: boolean) => void;
};

/**
 * Every window, one row each, as the drawing numbers them: its tag, where it is, its size to the eighth with the error
 * after it, how it was measured and what it is good for. The row picked (tape tint) opens under itself with why it
 * needs another look and what can be done to it. Windows that are only an estimate are one row for each size. The
 * foot says how many windows there are and lets the estimated counts be changed.
 */
export function WindowsTable({
  rows,
  selectedKey,
  onSelect,
  actions,
  summary,
  covers,
  countsOpen,
  onCountsOpen,
  footNote,
  styleTiles = DEFAULT_STYLE_TILES,
}: {
  rows: readonly WindowRow[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  actions: TableActions;
  /** "7 windows, 4 measured": the foot's line. */
  summary: ReactNode;
  /** Where the estimate covers: the whole house, or the sides and back once the front is measured. */
  covers: 'all-sides' | 'sides-and-back';
  countsOpen: boolean;
  onCountsOpen: (open: boolean) => void;
  footNote?: ReactNode;
  /** The company's plain window choices, to name a window's style the way the homeowner saw it. */
  styleTiles?: readonly StyleTile[];
}) {
  const countsId = useId();
  return (
    <div className={styles.host}>
      <Table className={styles.table} aria-label={copy.table.label}>
        <thead>
          <tr>
            <Th className={styles.tagHead}>{copy.table.columns.tag}</Th>
            <Th>{copy.table.columns.location}</Th>
            <Th className={styles.classCol}>{copy.table.columns.sizeClass}</Th>
            <Th>{copy.table.columns.size}</Th>
            <Th>{copy.table.columns.method}</Th>
            <Th>{copy.table.columns.status}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <Td colSpan={6} className={styles.empty}>
                {copy.table.empty}
              </Td>
            </tr>
          ) : null}
          {rows.map((row) => {
            const selected = row.key === selectedKey;
            const status = STATUS[row.status];
            const detailId = `window-detail-${row.key.replace(/[^a-z0-9]/gi, '-')}`;
            const name = row.kind === 'estimate' ? copy.table.estimateRowName(row.count, copy.sizeClass[row.sizeClass]) : row.name;
            return (
              <Fragment key={row.key}>
                <Tr
                  {...(selected ? { tone: 'tape' as const } : {})}
                  selected={selected}
                  className={styles.row}
                  data-row={row.key}
                  data-photo-window={row.kind === 'photo' ? (row.ids[0] ?? '') : undefined}
                  data-photos={row.kind === 'photo' ? row.photos : undefined}
                  data-status={row.status}
                  data-out={row.excluded ? 'true' : undefined}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('button, a, input, label, output')) return;
                    onSelect(selected ? null : row.key);
                  }}
                >
                  <Td className={styles.tagCell}>
                    <Button
                      variant="ghost"
                      className={styles.tag}
                      data-status={row.status}
                      data-selected={selected ? 'true' : undefined}
                      aria-pressed={selected}
                      aria-controls={selected ? detailId : undefined}
                      aria-label={copy.table.selectRow(row.tag, name)}
                      onClick={() => onSelect(selected ? null : row.key)}
                    >
                      <span className={styles.tagChip}>{row.tag}</span>
                    </Button>
                  </Td>
                  <Td className={styles.location}>
                    <span className={styles.name}>{name}</span>
                    {row.photos > 1 ? <span className={styles.sub}>{windowPhotos.photosOfWindow(row.photos)}</span> : null}
                    {row.style !== undefined ? (
                      <span className={styles.sub} data-window-style="">
                        {windowPhotos.styleLine(tileOfStyle(styleTiles, row.style).label, row.frosted === true)}
                      </span>
                    ) : null}
                  </Td>
                  <Td className={styles.classCol}>{copy.sizeClass[row.sizeClass]}</Td>
                  <Td className={styles.sizeCell}>
                    {row.size !== null ? (
                      <Size
                        w={toEighth(row.size.widthIn)}
                        h={toEighth(row.size.heightIn)}
                        pm={row.size.pm === null ? null : toSixteenthUp(row.size.pm)}
                        estimate={row.kind === 'street'}
                        scale="table"
                        copy={sizeCopy}
                        data-size={`${row.size.widthIn}x${row.size.heightIn}`}
                      />
                    ) : (
                      <span className={styles.united}>{copy.table.united(copy.sizeClassHint[row.sizeClass])}</span>
                    )}
                  </Td>
                  <Td className={styles.methodCell}>
                    <span className={styles.method} data-method={row.method}>
                      <Icon name={METHOD_ICON[row.method]} size={16} />
                      {copy.table.methods[row.method]}
                    </span>
                  </Td>
                  <Td className={styles.statusCell}>
                    <Tag tone={status.tone} {...(status.icon !== undefined && { icon: status.icon })}>
                      {copy.table.status[row.status]}
                    </Tag>
                  </Td>
                </Tr>
                {selected ? (
                  <tr className={styles.detailRow} id={detailId} data-detail={row.key}>
                    <td colSpan={6} className={styles.detail}>
                      <RowDetail row={row} name={name} covers={covers} actions={actions} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </Table>
      <div className={styles.foot}>
        <p className={styles.summary} data-windows-total="">
          {summary}
        </p>
        <div className={styles.footActions}>
          <Button variant="quiet" size="sm" aria-expanded={countsOpen} aria-controls={countsOpen ? countsId : undefined} onClick={() => onCountsOpen(!countsOpen)}>
            {copy.table.adjustCounts}
          </Button>
        </div>
      </div>
      {countsOpen ? (
        <div id={countsId} className={styles.counts} role="group" aria-label={copy.table.countsLabel}>
          <p className={styles.countsHint}>{copy.estimatedHint}</p>
          <div className={styles.countsGrid}>
            {WINDOW_SIZE_CLASSES.map((c) => (
              <CountStepper key={c} cls={c} value={actions.estimated.value(c)} estimate={actions.estimated.estimate(c)} onChange={(n) => actions.estimated.set(c, n)} />
            ))}
          </div>
          <p className={styles.countsHint}>{copy.sizeClassRule}</p>
          <div className={styles.countsFoot}>
            <Checkbox label={windowPhotos.coverAll} description={windowPhotos.coverAllHint} checked={actions.coverAll} onChange={actions.onCoverAll} />
            {actions.estimated.changed ? (
              <Button variant="ghost" size="sm" onClick={actions.estimated.reset}>
                {copy.resetCounts}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {footNote}
    </div>
  );
}

function RowDetail({ row, name, covers, actions }: { row: WindowRow; name: string; covers: 'all-sides' | 'sides-and-back'; actions: TableActions }) {
  if (row.kind === 'estimate') {
    return (
      <div className={styles.detailBody}>
        <p className={styles.detailText}>{copy.table.estimateDetail(copy.sizeClass[row.sizeClass].toLowerCase(), covers)}</p>
        <div className={styles.detailActions}>
          <Button variant="default" size="sm" onClick={actions.onAddPhotos}>
            {copy.table.measureOne}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.detailBody}>
      {row.reasons.length > 0 ? (
        <ul className={styles.reasons} aria-label={copy.table.reasonsLabel}>
          {row.reasons.map((r) => (
            <li key={r.kind} data-kind={r.kind}>
              {reasonText(r)}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.detailText}>
          {row.kind === 'street' ? copy.table.streetDetail : copy.table.fine}
          {row.was !== null ? ` ${copy.table.streetWas(row.was.widthIn, row.was.heightIn)}` : ''}
        </p>
      )}
      <div className={styles.detailActions}>
        {row.kind === 'photo' && row.open !== null ? (
          <Button variant={row.status === 'remeasure' ? 'primary' : 'default'} size="sm" aria-label={windowPhotos.rowLabel(name, row.size !== null ? copy.size(row.size.widthIn, row.size.heightIn) : copy.sizing)} onClick={() => actions.onMeasureAgain(row)}>
            {row.status === 'remeasure' ? copy.table.measureAgain : windowPhotos.edit}
          </Button>
        ) : null}
        <Checkbox label={windowPhotos.inQuote} checked={!row.excluded} onChange={() => actions.onToggle(row.ids)} />
        {row.kind === 'photo' ? (
          <Button variant="ghost" size="sm" aria-label={windowPhotos.deleteRow(name)} onClick={() => actions.onDelete(row.ids)}>
            {windowPhotos.remove}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
