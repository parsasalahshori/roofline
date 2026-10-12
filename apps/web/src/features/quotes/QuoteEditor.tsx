import { useEffect, useState } from 'react';
import type { Scope } from '@roofline/shared';
import { Field, Select } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';
import type { QuoteDraft } from './draft.ts';
import styles from './QuoteEditor.module.css';

export type QuoteEditorProps = {
  draft: QuoteDraft;
  readOnly: boolean;
  onChange: (draft: QuoteDraft) => void;
  onValidityChange?: (valid: boolean) => void;
};

type NumericKey =
  | 'areaSqFt'
  | 'pitch'
  | 'wastePercent'
  | 'stories'
  | 'layers'
  | 'ridgeFt'
  | 'edgeFt'
  | 'valleyFt'
  | 'deckingSheets'
  | 'markupPercent'
  | 'taxPercent';

/** The ranges of scopeSchema in packages/shared/src/pricing.ts. `above` means the minimum itself is not allowed. */
const RANGES: Record<NumericKey, { min: number; max: number; integer?: boolean; above?: boolean }> = {
  areaSqFt: { min: 0, max: 100000, above: true },
  pitch: { min: 0, max: 24 },
  wastePercent: { min: 0, max: 50 },
  stories: { min: 1, max: 4, integer: true },
  layers: { min: 0, max: 4, integer: true },
  ridgeFt: { min: 0, max: 10000 },
  edgeFt: { min: 0, max: 10000 },
  valleyFt: { min: 0, max: 10000 },
  deckingSheets: { min: 0, max: 1000, integer: true },
  markupPercent: { min: 0, max: 100 },
  taxPercent: { min: 0, max: 15 },
};

const NUMERIC_KEYS = Object.keys(RANGES) as NumericKey[];
const AREA_TYPES: ReadonlyArray<Scope['areaType']> = ['surface', 'footprint'];
const MATERIALS: ReadonlyArray<Scope['material']> = ['architectural', 'premium', 'metal'];

/** The number a typed text stands for, or null when it is blank, not a number or out of range. Integers round. */
function parseNumber(key: NumericKey, text: string): number | null {
  const range = RANGES[key];
  if (text.trim() === '') return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  const value = range.integer ? Math.round(parsed) : parsed;
  if (value > range.max || value < range.min) return null;
  if (range.above && value <= range.min) return null;
  return value;
}

function textsFrom(scope: Scope): Record<NumericKey, string> {
  return {
    areaSqFt: String(scope.areaSqFt),
    pitch: String(scope.pitch),
    wastePercent: String(scope.wastePercent),
    stories: String(scope.stories),
    layers: String(scope.layers),
    ridgeFt: String(scope.ridgeFt),
    edgeFt: String(scope.edgeFt),
    valleyFt: String(scope.valleyFt),
    deckingSheets: String(scope.deckingSheets),
    markupPercent: String(scope.markupPercent),
    taxPercent: String(scope.taxPercent),
  };
}

/**
 * The quote inputs. Controlled and stateless about prices: it never calculates or fetches; the
 * window owns the draft and prices it. Number boxes keep their own text so a person can clear
 * the box or type "1." freely; only a valid number reaches onChange.
 */
export function QuoteEditor({ draft, readOnly, onChange, onValidityChange }: QuoteEditorProps) {
  const { scope } = draft;
  const { areaSqFt, pitch, wastePercent, stories, layers, ridgeFt, edgeFt, valleyFt, deckingSheets, markupPercent, taxPercent } = scope;
  const [texts, setTexts] = useState<Record<NumericKey, string>>(() => textsFrom(scope));
  const values: Record<NumericKey, number> = {
    areaSqFt,
    pitch,
    wastePercent,
    stories,
    layers,
    ridgeFt,
    edgeFt,
    valleyFt,
    deckingSheets,
    markupPercent,
    taxPercent,
  };
  const [synced, setSynced] = useState<Record<NumericKey, number>>(values);

  // A new draft (for example after a save) replaces the text of any number whose text no longer
  // matches it. Done while rendering, when a draft value has changed, so typing is never reset.
  if (NUMERIC_KEYS.some((key) => synced[key] !== values[key])) {
    setSynced(values);
    setTexts((previous) => {
      let next = previous;
      for (const key of NUMERIC_KEYS) {
        if (synced[key] !== values[key] && parseNumber(key, previous[key]) !== values[key]) {
          if (next === previous) next = { ...previous };
          next[key] = String(values[key]);
        }
      }
      return next;
    });
  }

  const isInvalid = (key: NumericKey): boolean => parseNumber(key, texts[key]) === null;
  const anyInvalid = NUMERIC_KEYS.some(isInvalid);
  useEffect(() => {
    onValidityChange?.(!anyInvalid);
  }, [anyInvalid, onValidityChange]);

  const update = (patch: Partial<Scope>) => onChange({ ...draft, scope: { ...draft.scope, ...patch } });

  const changeNumber = (key: NumericKey, text: string) => {
    setTexts((previous) => ({ ...previous, [key]: text }));
    const value = parseNumber(key, text);
    if (value !== null) update({ [key]: value });
  };

  const numberField = (key: NumericKey, label: string, inputMode: 'decimal' | 'numeric') => (
    <Field
      key={key}
      className={styles.cell}
      label={label}
      type="number"
      inputMode={inputMode}
      step={RANGES[key].integer ? 1 : 'any'}
      value={texts[key]}
      error={isInvalid(key) ? quotes.fieldError : undefined}
      disabled={readOnly}
      onChange={(event) => changeNumber(key, event.currentTarget.value)}
    />
  );

  return (
    <section aria-label={quotes.editorLabel} className={styles.editor}>
      <fieldset className={styles.group}>
        <legend className={styles.heading}>{quotes.measurementHeading}</legend>
        <div className={styles.grid}>
          {numberField('areaSqFt', quotes.area, 'decimal')}
          <Select
            className={styles.cell}
            label={quotes.areaType}
            value={scope.areaType}
            options={AREA_TYPES.map((value) => ({ value, label: quotes.areaTypeOptions[value] }))}
            disabled={readOnly}
            onChange={(value) => update({ areaType: value as Scope['areaType'] })}
          />
          {numberField('pitch', quotes.pitch, 'decimal')}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.heading}>{quotes.scopeHeading}</legend>
        <div className={styles.grid}>
          <Select
            className={styles.cell}
            label={quotes.material}
            value={scope.material}
            options={MATERIALS.map((value) => ({ value, label: quotes.materialOptions[value] }))}
            disabled={readOnly}
            onChange={(value) => update({ material: value as Scope['material'] })}
          />
          {numberField('wastePercent', quotes.waste, 'decimal')}
          {numberField('stories', quotes.stories, 'numeric')}
          {numberField('layers', quotes.layers, 'numeric')}
          {numberField('ridgeFt', quotes.ridgeFt, 'decimal')}
          {numberField('edgeFt', quotes.edgeFt, 'decimal')}
          {numberField('valleyFt', quotes.valleyFt, 'decimal')}
          {numberField('deckingSheets', quotes.deckingSheets, 'numeric')}
          {numberField('markupPercent', quotes.markup, 'decimal')}
          {numberField('taxPercent', quotes.tax, 'decimal')}
          <Field
            className={styles.wide}
            label={quotes.notes}
            multiline
            rows={3}
            value={draft.notes}
            disabled={readOnly}
            onChange={(event) => onChange({ ...draft, notes: event.currentTarget.value })}
          />
        </div>
      </fieldset>

      {anyInvalid ? <p className={styles.hint}>{quotes.fixInputs}</p> : null}
    </section>
  );
}
