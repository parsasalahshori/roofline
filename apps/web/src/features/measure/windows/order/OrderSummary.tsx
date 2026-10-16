import { Button, Listbox, Panel, Size, Table, Td, Th, Tr } from '@roofline/ui';
import type { FrameColor, GlassPackage, GridType, OrderGroup, OrderTotals, ScreenType, WindowStyle } from '@roofline/shared';
import { useState } from 'react';
import { sizeCopy } from '../../../../copy/measureWindows.ts';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { colorOptions, glassOptions, gridOptions, screenOptions, styleOptions } from './OrderLine.tsx';
import styles from './OrderWindow.module.css';

/** What the bulk bar sets on every selected line; a missing field is left as it is. */
export type BulkChange = {
  style?: WindowStyle;
  frameExterior?: FrameColor;
  frameInterior?: FrameColor;
  gridType?: GridType;
  glass?: GlassPackage;
  screen?: ScreenType;
  tempered?: boolean;
};

const leave = { value: '', label: copy.leaveAsIs };

/** With lines selected: pick options once and apply them to every selected line in one save. */
export function BulkBar({ count, onApply, onClear }: { count: number; onApply: (change: BulkChange) => void; onClear: () => void }) {
  const [style, setStyle] = useState('');
  const [ext, setExt] = useState('');
  const [int, setInt] = useState('');
  const [grid, setGrid] = useState('');
  const [glass, setGlass] = useState('');
  const [screen, setScreen] = useState('');
  const [tempered, setTempered] = useState('');
  const change: BulkChange = {
    ...(style !== '' && { style: style as WindowStyle }),
    ...(ext !== '' && { frameExterior: ext as FrameColor }),
    ...(int !== '' && { frameInterior: int as FrameColor }),
    ...(grid !== '' && { gridType: grid as GridType }),
    ...(glass !== '' && { glass: glass as GlassPackage }),
    ...(screen !== '' && { screen: screen as ScreenType }),
    ...(tempered !== '' && { tempered: tempered === 'yes' }),
  };
  const empty = Object.keys(change).length === 0;

  return (
    <section className={styles.bulk} aria-label={copy.bulkLabel} data-bulk="">
      <p className={styles.bulkCount} role="status">
        {copy.bulkSelected(count)}
      </p>
      <div className={styles.bulkFields}>
        <Listbox label={copy.style} value={style} options={[leave, ...styleOptions]} onChange={setStyle} />
        <Listbox label={copy.exterior} value={ext} options={[leave, ...colorOptions]} onChange={setExt} />
        <Listbox label={copy.interior} value={int} options={[leave, ...colorOptions]} onChange={setInt} />
        <Listbox label={copy.grid} value={grid} options={[leave, ...gridOptions]} onChange={setGrid} />
        <Listbox label={copy.glass} value={glass} options={[leave, ...glassOptions]} onChange={setGlass} />
        <Listbox label={copy.screen} value={screen} options={[leave, ...screenOptions]} onChange={setScreen} />
        <Listbox
          label={copy.tempered}
          value={tempered}
          options={[leave, { value: 'yes', label: copy.bulkTemperedYes }, { value: 'no', label: copy.bulkTemperedNo }]}
          onChange={setTempered}
        />
      </div>
      <div className={styles.bulkActions}>
        <Button disabled={empty} onClick={() => onApply(change)}>
          {copy.bulkApply(count)}
        </Button>
        <Button variant="default" onClick={onClear}>
          {copy.bulkClear}
        </Button>
      </div>
    </section>
  );
}

function gridText(g: OrderGroup): string {
  if (g.grid.type === 'none') return copy.grids.none;
  const patterns = [g.grid.top, g.grid.bottom].filter((p) => p !== '').join(' / ');
  return copy.sheetGrid(copy.grids[g.grid.type], patterns);
}

/** A sheet line's options in a few words: colours, grid, glass, tempered, obscure, screen, notes. */
export function optionsText(g: OrderGroup): string {
  return [
    copy.colorsPair(copy.colors[g.frameExterior], copy.colors[g.frameInterior]),
    gridText(g),
    copy.glasses[g.glass],
    ...(g.tempered ? [copy.tempered] : []),
    ...(g.obscure ? [copy.obscure] : []),
    copy.screens[g.screen],
    ...(g.specialOrder ? [copy.specialOrder] : []),
    ...(g.notes !== '' ? [g.notes] : []),
  ].join(', ');
}

const one = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

/** The order's totals and the sheet as the factory will see it, grouped. */
export function OrderSummary({ totals, groups }: { totals: OrderTotals; groups: OrderGroup[] }) {
  const items: [string, string][] = [
    [copy.totals.windows, totals.windows.toLocaleString()],
    [copy.totals.unitedIn, one(totals.unitedIn)],
    [copy.totals.sqFt, one(totals.sqFt)],
    [copy.totals.lines, totals.lines.toLocaleString()],
    [copy.totals.specialOrders, totals.specialOrders.toLocaleString()],
  ];
  return (
    <div className={styles.summary}>
      <Panel title={copy.totalsTitle} headingLevel={2}>
        <dl className={styles.totals} data-totals="">
          {items.map(([label, value]) => (
            <div key={label} className={styles.total}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      <Panel title={copy.sheetTitle} headingLevel={2} padded={false}>
        {groups.length === 0 ? (
          <p className={styles.sheetEmpty}>{copy.sheetEmpty}</p>
        ) : (
          <Table className={styles.preview} regionLabel={copy.sheetTitle}>
            <caption className="visually-hidden">{copy.sheetCaption}</caption>
            <thead>
              <tr>
                <Th>{copy.sheetColumns.line}</Th>
                <Th numeric>{copy.sheetColumns.qty}</Th>
                <Th>{copy.sheetColumns.locations}</Th>
                <Th>{copy.sheetColumns.style}</Th>
                <Th>{copy.sheetColumns.size}</Th>
                <Th>{copy.sheetColumns.options}</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Tr key={g.lineNo} data-group={g.lineNo}>
                  <Td numeric>{g.lineNo}</Td>
                  <Td numeric>{g.quantity}</Td>
                  <Td>{g.locations.join(', ')}</Td>
                  <Td>{copy.styles[g.style]}</Td>
                  <Td className={styles.nowrap}>
                    <Size w={g.widthIn} h={g.heightIn} copy={sizeCopy} />
                  </Td>
                  <Td>{optionsText(g)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
}
