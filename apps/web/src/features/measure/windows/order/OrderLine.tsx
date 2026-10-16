import { Button, Checkbox, Field, Select, Toggle } from '@roofline/ui';
import {
  FRAME_COLORS,
  GLASS_PACKAGES,
  GRID_TYPES,
  MAX_LOCATION_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_ORDER_QUANTITY,
  SCREEN_TYPES,
  smallestMeasured,
  WINDOW_STYLES,
  type CheckedLine,
  type FrameColor,
  type GlassPackage,
  type GridType,
  type OrderLineStatus,
  type SafetyAnswers,
  type ScreenType,
  type WindowOrderLine,
  type WindowOrderLinePatch,
  type WindowStyle,
} from '@roofline/shared';
import { useId } from 'react';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { uploadSrc } from '../api.ts';
import styles from './OrderWindow.module.css';

/** A line's editable fields, without its id. */
export type LineEdit = Omit<WindowOrderLinePatch, 'id'>;

const ONE_SASH: ReadonlySet<WindowStyle> = new Set(['picture', 'casement', 'awning', 'arch', 'circle']);
const SLIDERS: ReadonlySet<WindowStyle> = new Set(['slider-2', 'slider-3']);

export const styleOptions = WINDOW_STYLES.map((s) => ({ value: s, label: copy.styles[s] }));
export const colorOptions = FRAME_COLORS.map((c) => ({ value: c, label: copy.colors[c] }));
export const gridOptions = GRID_TYPES.map((g) => ({ value: g, label: copy.grids[g] }));
export const glassOptions = GLASS_PACKAGES.map((g) => ({ value: g, label: copy.glasses[g] }));
export const screenOptions = SCREEN_TYPES.map((s) => ({ value: s, label: copy.screens[s] }));

const STATUS_GLYPH: Record<OrderLineStatus, string> = { ready: '✓', check: '!', error: '×' };

/** A status chip: a glyph and a word, so it never rests on colour alone. */
export function LineStatus({ status }: { status: OrderLineStatus }) {
  return (
    <span className={styles.lineStatus} data-status={status}>
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      <span className="visually-hidden">{copy.lineStatusLabel(copy.lineStatus[status])}</span>
      <span aria-hidden="true">{copy.lineStatus[status]}</span>
    </span>
  );
}

/** A yes/no question: two pressed-state buttons. Pressing the chosen answer again clears it (not answered). */
function YesNo({ label, value, disabled, onChange }: { label: string; value: boolean | null; disabled: boolean; onChange: (next: boolean | null) => void }) {
  const id = useId();
  return (
    <div className={styles.yesNo} role="group" aria-labelledby={id}>
      <span id={id} className={styles.question}>
        {label}
      </span>
      <span className={styles.yesNoButtons}>
        <Button
          variant="ghost"
          className={styles.answer}
          aria-pressed={value === true}
          data-on={value === true ? 'true' : undefined}
          disabled={disabled}
          onClick={() => onChange(value === true ? null : true)}
        >
          {copy.yes}
        </Button>
        <Button
          variant="ghost"
          className={styles.answer}
          aria-pressed={value === false}
          data-on={value === false ? 'true' : undefined}
          disabled={disabled}
          onClick={() => onChange(value === false ? null : false)}
        >
          {copy.no}
        </Button>
      </span>
    </div>
  );
}

function gridLabels(style: WindowStyle | null): { top: string; bottom: string | null } {
  if (style !== null && ONE_SASH.has(style)) return { top: copy.gridOnly, bottom: null };
  if (style !== null && SLIDERS.has(style)) return { top: copy.gridLeft, bottom: copy.gridRight };
  return { top: copy.gridTop, bottom: copy.gridBottom };
}

const intOrNull = (text: string): number | null => {
  if (text.trim() === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

type Props = {
  line: WindowOrderLine;
  checked: CheckedLine;
  n: number;
  measurementId: string;
  locked: boolean;
  selected: boolean;
  onSelect: (next: boolean) => void;
  /** Shows the change at once and saves it after the pause; `localOnly` shows it without saving (a half-typed number). */
  onEdit: (edit: LineEdit, localOnly?: boolean) => void;
};

/** One order line: a summary row (photo, location, sizes, quantity, status) and a row of its options under it. */
export function OrderLine({ line, checked, n, measurementId, locked, selected, onSelect, onEdit }: Props) {
  const measured = smallestMeasured(line.measured);
  const labels = gridLabels(line.style);
  const setSafety = (next: Partial<SafetyAnswers>) => onEdit({ safety: { ...line.safety, ...next } });
  const showSuggestions = checked.suggestions.length > 0 && !line.tempered;
  const name = line.location.trim() === '' ? copy.windowNumber(n) : line.location;

  return (
    <tbody className={styles.line} data-line={line.id} data-status={checked.status}>
      <tr className={styles.summaryRow}>
        <td className={styles.selectCell}>
          <Checkbox checked={selected} disabled={locked} onChange={onSelect} label={<span className="visually-hidden">{copy.selectLine(n, name)}</span>} />
        </td>
        <td className={styles.photoCell}>
          <img className={styles.thumb} src={uploadSrc(measurementId, line.uploadId)} alt={copy.photoAlt(name)} width={64} height={64} loading="lazy" />
        </td>
        <td className={styles.locationCell}>
          <div className={styles.locationInner}>
            <span className={styles.lineNo} aria-hidden="true">
              {n}
            </span>
            <Field
              className={styles.compactField}
              label={copy.locationFor(n)}
              labelHidden
              value={line.location}
              maxLength={MAX_LOCATION_LENGTH}
              disabled={locked}
              onChange={(e) => onEdit({ location: e.currentTarget.value })}
            />
          </div>
        </td>
        <td className={styles.sizeCell} data-label={copy.columns.measured}>
          {measured === null ? (
            copy.noSize
          ) : (
            <>
              <span data-measured="">{copy.size(measured.widthIn, measured.heightIn)}</span>
              {measured.uncertaintyIn !== null ? <span className={styles.muted}>{copy.plusMinus(measured.uncertaintyIn)}</span> : null}
              {line.measured.length > 1 ? <span className={styles.muted}>{copy.photosCount(line.measured.length)}</span> : null}
            </>
          )}
        </td>
        <td className={styles.sizeCell} data-label={copy.columns.order}>
          {checked.order === null ? (
            copy.noSize
          ) : (
            <strong className={styles.orderSize} data-order-size="">
              {copy.size(checked.order.widthIn, checked.order.heightIn)}
            </strong>
          )}
          {checked.specialOrder ? <span className={styles.special}>{copy.specialOrder}</span> : null}
        </td>
        <td className={styles.qtyCell}>
          <Field
            className={styles.compactField}
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
              onEdit({ quantity: Number.isFinite(q) ? q : 0 }, !ok);
            }}
          />
        </td>
        <td className={styles.statusCell}>
          <LineStatus status={checked.status} />
          {checked.reasons.length > 0 ? (
            <ul className={styles.reasons} aria-label={copy.reasonsLabel}>
              {checked.reasons.map((r) => (
                <li key={r.message} data-level={r.level}>
                  {r.message}
                </li>
              ))}
            </ul>
          ) : null}
          {checked.status === 'check' ? (
            <Checkbox checked={line.confirmed} disabled={locked} label={copy.confirm} onChange={(next) => onEdit({ confirmed: next })} />
          ) : null}
        </td>
      </tr>
      <tr className={styles.optionsRow}>
        <td colSpan={7}>
          <fieldset className={styles.options} disabled={locked}>
            <legend className="visually-hidden">{copy.optionsFor(n, name)}</legend>
            <Select
              label={copy.style}
              value={line.style ?? ''}
              disabled={locked}
              options={[{ value: '', label: copy.pickStyle }, ...styleOptions]}
              onChange={(v) => onEdit({ style: v === '' ? null : (v as WindowStyle) })}
            />
            <Select label={copy.exterior} value={line.frameExterior} disabled={locked} options={colorOptions} onChange={(v) => onEdit({ frameExterior: v as FrameColor })} />
            <Select label={copy.interior} value={line.frameInterior} disabled={locked} options={colorOptions} onChange={(v) => onEdit({ frameInterior: v as FrameColor })} />
            <Select label={copy.grid} value={line.grid.type} disabled={locked} options={gridOptions} onChange={(v) => onEdit({ grid: { ...line.grid, type: v as GridType } })} />
            {line.grid.type !== 'none' ? (
              <>
                <Field
                  label={labels.top}
                  placeholder={copy.gridPlaceholder}
                  value={line.grid.top}
                  maxLength={3}
                  disabled={locked}
                  onChange={(e) => onEdit({ grid: { ...line.grid, top: e.currentTarget.value.trim().toLowerCase() } })}
                />
                {labels.bottom !== null ? (
                  <Field
                    label={labels.bottom}
                    placeholder={copy.gridPlaceholder}
                    value={line.grid.bottom}
                    maxLength={3}
                    disabled={locked}
                    onChange={(e) => onEdit({ grid: { ...line.grid, bottom: e.currentTarget.value.trim().toLowerCase() } })}
                  />
                ) : null}
              </>
            ) : null}
            <Select label={copy.glass} value={line.glass} disabled={locked} options={glassOptions} onChange={(v) => onEdit({ glass: v as GlassPackage })} />
            <Select label={copy.screen} value={line.screen} disabled={locked} options={screenOptions} onChange={(v) => onEdit({ screen: v as ScreenType })} />
            <div className={styles.toggles}>
              <Toggle label={copy.tempered} checked={line.tempered} disabled={locked} onChange={(next) => onEdit({ tempered: next })} />
              <Toggle label={copy.obscure} checked={line.obscure} disabled={locked} onChange={(next) => onEdit({ obscure: next })} />
            </div>
            <Field
              className={styles.notes}
              label={copy.notes}
              multiline
              rows={2}
              value={line.notes}
              maxLength={MAX_NOTES_LENGTH}
              disabled={locked}
              onChange={(e) => onEdit({ notes: e.currentTarget.value })}
            />
            <section className={styles.safety} aria-label={copy.safetyTitle}>
              <h4 className={styles.safetyTitle}>{copy.safetyTitle}</h4>
              <YesNo label={copy.besideDoor} value={line.safety.besideDoor} disabled={locked} onChange={(v) => setSafety({ besideDoor: v })} />
              <YesNo label={copy.wetArea} value={line.safety.wetArea} disabled={locked} onChange={(v) => setSafety({ wetArea: v })} />
              <YesNo label={copy.walkway} value={line.safety.walkway} disabled={locked} onChange={(v) => setSafety({ walkway: v })} />
              <Field
                className={styles.sill}
                label={copy.sill}
                help={copy.sillHelp}
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={line.safety.sillHeightIn === null ? '' : String(line.safety.sillHeightIn)}
                disabled={locked}
                onChange={(e) => setSafety({ sillHeightIn: intOrNull(e.currentTarget.value) })}
              />
              {showSuggestions ? (
                <div className={styles.suggestions} data-suggestions="">
                  {checked.suggestions.map((s) => (
                    <p key={s.rule} className={styles.suggestion}>
                      {s.message}
                    </p>
                  ))}
                  {!locked ? (
                    <Button variant="ghost" className={styles.useTempered} onClick={() => onEdit({ tempered: true })}>
                      {copy.useTempered}
                    </Button>
                  ) : null}
                </div>
              ) : checked.suggestions.length > 0 ? (
                <p className={styles.muted}>{copy.temperedChosen}</p>
              ) : null}
            </section>
          </fieldset>
        </td>
      </tr>
    </tbody>
  );
}
