import { Button, Checkbox, Field, Icon, Listbox, Panel, Size, Table, Tag, Td, Th, Toggle, Tr, type IconName, type TagTone } from '@roofline/ui';
import {
  FRAME_COLORS,
  GLASS_PACKAGES,
  GRID_TYPES,
  MAX_NOTES_LENGTH,
  orderGradeMeasured,
  SCREEN_TYPES,
  WINDOW_STYLES,
  type CheckedLine,
  type FrameColor,
  type GlassPackage,
  type GridType,
  type MeasuredSize,
  type OrderLineStatus,
  type SafetyAnswers,
  type ScreenType,
  type WindowOrderLine,
  type WindowOrderLinePatch,
  type WindowStyle,
} from '@roofline/shared';
import { useId } from 'react';
import { sizeCopy } from '../../../../copy/measureWindows.ts';
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

/** Ready is green, a line to look at is tape yellow (it needs the person's OK), a hold is red. Each has its glyph and its word. */
const STATUS_TAG: Record<OrderLineStatus, { tone: TagTone; icon: IconName }> = {
  ready: { tone: 'ok', icon: 'check' },
  check: { tone: 'tape', icon: 'alert' },
  error: { tone: 'bad', icon: 'lock' },
};

/** A status tag: a glyph and a word, so it never rests on colour alone. */
export function LineStatus({ status }: { status: OrderLineStatus }) {
  return (
    <Tag tone={STATUS_TAG[status].tone} icon={STATUS_TAG[status].icon} data-status={status}>
      <span className="visually-hidden">{copy.lineStatusLabel(copy.lineStatus[status])}</span>
      <span aria-hidden="true">{copy.lineStatus[status]}</span>
    </Tag>
  );
}

/** How a line is built, in a few words for the table: style first, then glass, grid, tempered, obscure and the rest. */
export function lineSpec(line: WindowOrderLine, checked: CheckedLine, withColors: boolean): { name: string; rest: string[] } {
  const rest = [
    copy.glassShort[line.glass],
    ...(line.grid.type !== 'none' ? [copy.grids[line.grid.type]] : []),
    ...(line.tempered ? [copy.tempered] : []),
    ...(line.obscure ? [copy.obscure] : []),
    ...(line.screen !== 'full' ? [copy.screens[line.screen]] : []),
    ...(checked.specialOrder ? [copy.specialOrder] : []),
    ...(withColors ? [copy.colorsSlash(copy.colors[line.frameExterior], copy.colors[line.frameInterior])] : []),
  ];
  return { name: line.style === null ? copy.pickStyle : copy.styles[line.style], rest };
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
          variant="default"
          size="sm"
          className={styles.answer}
          aria-pressed={value === true}
          data-on={value === true ? 'true' : undefined}
          disabled={disabled}
          onClick={() => onChange(value === true ? null : true)}
        >
          {copy.yes}
        </Button>
        <Button
          variant="default"
          size="sm"
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

/** The error of a reading, as the one number the readout shows after the size: the larger of width and height. */
const errorOf = (m: MeasuredSize): number | null => (m.uncertaintyIn === null ? null : Math.max(m.uncertaintyIn.width, m.uncertaintyIn.height));

/** Each photo's reading of the window, with which of its sides the order takes (the smallest of each, over the photos). */
function Readings({ measured }: { measured: readonly MeasuredSize[] }) {
  const grade = orderGradeMeasured(measured);
  const minW = Math.min(...grade.map((m) => m.widthIn));
  const minH = Math.min(...grade.map((m) => m.heightIn));
  let photo = 0;
  return (
    <div className={styles.readings}>
      <Table className={styles.readingsTable} aria-label={copy.readings.title}>
        <thead>
          <tr>
            <Th>{copy.readings.head.photo}</Th>
            <Th>{copy.readings.head.size}</Th>
          </tr>
        </thead>
        <tbody>
          {measured.map((m, i) => {
            const counts = grade.includes(m);
            const takesW = counts && m.widthIn === minW;
            const takesH = counts && m.heightIn === minH;
            const label = m.quoteOnly === true ? copy.readings.roomScan : copy.readings.photo(++photo);
            return (
              <Tr key={i} {...(takesW || takesH ? { tone: 'tape' as const } : {})} className={styles.reading} data-reading={i}>
                <Td>{label}</Td>
                <Td>
                  <span className={styles.readingSize}>
                    <Size w={m.widthIn} h={m.heightIn} pm={errorOf(m)} copy={sizeCopy} />
                    {takesW || takesH ? (
                      <span className={styles.smallest} data-smallest={takesW && takesH ? 'both' : takesW ? 'width' : 'height'}>
                        {copy.readings.smallest[takesW && takesH ? 'both' : takesW ? 'width' : 'height']}
                      </span>
                    ) : null}
                  </span>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
      <p className={styles.readingsNote}>{copy.readings.note}</p>
    </div>
  );
}

type Props = {
  line: WindowOrderLine;
  checked: CheckedLine;
  n: number;
  measurementId: string;
  locked: boolean;
  /** Shows the change at once and saves it after the pause. */
  onEdit: (edit: LineEdit) => void;
};

/**
 * The picked window: its photo, what each photo read, why it needs another look (and the box that says it was checked),
 * and how it is built: style, colours, grid, glass, screen, tempered, obscure, notes and the safety-glass questions.
 */
export function LineDetail({ line, checked, n, measurementId, locked, onEdit }: Props) {
  const labels = gridLabels(line.style);
  const setSafety = (next: Partial<SafetyAnswers>) => onEdit({ safety: { ...line.safety, ...next } });
  const showSuggestions = checked.suggestions.length > 0 && !line.tempered;
  const name = line.location.trim() === '' ? copy.windowNumber(n) : line.location;

  return (
    <Panel as="aside" title={copy.detailTitle(n, name)} tag={<LineStatus status={checked.status} />} className={styles.detailPanel} data-detail={line.id} data-status={checked.status}>
      <div className={styles.detailBody}>
        <div className={styles.detailLook}>
          {line.uploadId !== null ? (
            <img className={styles.photo} src={uploadSrc(measurementId, line.uploadId)} alt={copy.photoAlt(name)} loading="lazy" />
          ) : (
            <p className={styles.noPhoto}>{copy.noPhoto}</p>
          )}
          <Readings measured={line.measured} />

          {checked.reasons.length > 0 ? (
            <ul className={styles.reasons} aria-label={copy.reasonsLabel}>
              {checked.reasons.map((r) => (
                <li key={r.message} data-level={r.level}>
                  <Icon name="alert" size={16} />
                  <span>{r.message}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {checked.status === 'check' ? <Checkbox checked={line.confirmed} disabled={locked} label={copy.confirm} onChange={(next) => onEdit({ confirmed: next })} /> : null}
        </div>

        <fieldset className={styles.options} disabled={locked}>
          <legend className={styles.optionsTitle}>
            <span className="visually-hidden">{copy.optionsFor(n, name)}</span>
            <span aria-hidden="true">{copy.optionsTitle}</span>
          </legend>
          <Listbox
            label={copy.style}
            value={line.style ?? ''}
            disabled={locked}
            options={[{ value: '', label: copy.pickStyle }, ...styleOptions]}
            onChange={(v) => onEdit({ style: v === '' ? null : (v as WindowStyle) })}
          />
          <div className={styles.pair}>
            <Listbox label={copy.exterior} value={line.frameExterior} disabled={locked} options={colorOptions} onChange={(v) => onEdit({ frameExterior: v as FrameColor })} />
            <Listbox label={copy.interior} value={line.frameInterior} disabled={locked} options={colorOptions} onChange={(v) => onEdit({ frameInterior: v as FrameColor })} />
          </div>
          <div className={styles.pair}>
            <Listbox label={copy.grid} value={line.grid.type} disabled={locked} options={gridOptions} onChange={(v) => onEdit({ grid: { ...line.grid, type: v as GridType } })} />
            <Listbox label={copy.screen} value={line.screen} disabled={locked} options={screenOptions} onChange={(v) => onEdit({ screen: v as ScreenType })} />
          </div>
          {line.grid.type !== 'none' ? (
            <div className={styles.pair}>
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
            </div>
          ) : null}
          <Listbox label={copy.glass} value={line.glass} disabled={locked} options={glassOptions} onChange={(v) => onEdit({ glass: v as GlassPackage })} />
          <div className={styles.toggles}>
            <Toggle label={copy.tempered} checked={line.tempered} disabled={locked} onChange={(next) => onEdit({ tempered: next })} />
            <Toggle label={copy.obscure} checked={line.obscure} disabled={locked} onChange={(next) => onEdit({ obscure: next })} />
          </div>
          <Field
            label={copy.notes}
            multiline
            rows={2}
            value={line.notes}
            maxLength={MAX_NOTES_LENGTH}
            disabled={locked}
            onChange={(e) => onEdit({ notes: e.currentTarget.value })}
          />
          <section className={styles.safety} aria-label={copy.safetyTitle}>
            <h3 className={styles.safetyTitle}>{copy.safetyTitle}</h3>
            <YesNo label={copy.besideDoor} value={line.safety.besideDoor} disabled={locked} onChange={(v) => setSafety({ besideDoor: v })} />
            <YesNo label={copy.wetArea} value={line.safety.wetArea} disabled={locked} onChange={(v) => setSafety({ wetArea: v })} />
            <YesNo label={copy.walkway} value={line.safety.walkway} disabled={locked} onChange={(v) => setSafety({ walkway: v })} />
            <Field
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
                  <Button variant="default" size="sm" className={styles.useTempered} onClick={() => onEdit({ tempered: true })}>
                    {copy.useTempered}
                  </Button>
                ) : null}
              </div>
            ) : checked.suggestions.length > 0 ? (
              <p className={styles.muted}>{copy.temperedChosen}</p>
            ) : null}
          </section>
        </fieldset>
      </div>
    </Panel>
  );
}
