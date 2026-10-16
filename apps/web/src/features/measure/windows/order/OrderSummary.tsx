import { Button, Select } from '@roofline/ui';
import type { FrameColor, GlassPackage, GridType, OrderGroup, OrderTotals, ScreenType, WindowStyle } from '@roofline/shared';
import { useState } from 'react';
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
        <Select label={copy.style} value={style} options={[leave, ...styleOptions]} onChange={setStyle} />
        <Select label={copy.exterior} value={ext} options={[leave, ...colorOptions]} onChange={setExt} />
        <Select label={copy.interior} value={int} options={[leave, ...colorOptions]} onChange={setInt} />
        <Select label={copy.grid} value={grid} options={[leave, ...gridOptions]} onChange={setGrid} />
        <Select label={copy.glass} value={glass} options={[leave, ...glassOptions]} onChange={setGlass} />
        <Select label={copy.screen} value={screen} options={[leave, ...screenOptions]} onChange={setScreen} />
        <Select
          label={copy.tempered}
          value={tempered}
          options={[leave, { value: 'yes', label: copy.bulkTemperedYes }, { value: 'no', label: copy.bulkTemperedNo }]}
          onChange={setTempered}
        />
      </div>
      <div className={styles.bulkActions}>
        <Button className={styles.tall} disabled={empty} onClick={() => onApply(change)}>
          {copy.bulkApply(count)}
        </Button>
        <Button variant="ghost" className={styles.tall} onClick={onClear}>
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
    <>
      <section className={styles.panel} aria-labelledby="order-totals-title">
        <h3 id="order-totals-title" className={styles.panelTitle}>
          {copy.totalsTitle}
        </h3>
        <dl className={styles.totals} data-totals="">
          {items.map(([label, value]) => (
            <div key={label} className={styles.total}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className={styles.panel} aria-labelledby="order-sheet-title">
        <h3 id="order-sheet-title" className={styles.panelTitle}>
          {copy.sheetTitle}
        </h3>
        {groups.length === 0 ? (
          <p className={styles.muted}>{copy.sheetEmpty}</p>
        ) : (
          <div className={styles.sheetScroll}>
            <table className={styles.sheet}>
              <caption className={styles.sheetCaption}>{copy.sheetCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">{copy.sheetColumns.line}</th>
                  <th scope="col">{copy.sheetColumns.qty}</th>
                  <th scope="col">{copy.sheetColumns.locations}</th>
                  <th scope="col">{copy.sheetColumns.style}</th>
                  <th scope="col">{copy.sheetColumns.size}</th>
                  <th scope="col">{copy.sheetColumns.options}</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.lineNo} data-group={g.lineNo}>
                    <td>{g.lineNo}</td>
                    <td>{g.quantity}</td>
                    <td>{g.locations.join(', ')}</td>
                    <td>{copy.styles[g.style]}</td>
                    <td className={styles.nowrap}>{copy.size(g.widthIn, g.heightIn)}</td>
                    <td>{optionsText(g)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
