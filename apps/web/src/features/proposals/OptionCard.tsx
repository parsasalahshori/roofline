import { useMemo, useState } from 'react';
import { ADD_ON_UNITS, materialNames, priceTier, toSurfaceArea } from '@roofline/shared';
import type { AddOn, AddOnUnit, MeasuredQuantities, MeasurementKind, Pricebook, ProposalOptionView, Scope } from '@roofline/shared';
import { Button, Card, Field, IconButton, Pill, Select, Toggle } from '@roofline/ui';
import { proposals } from '../../copy/proposals.ts';
import type { OptionPatch } from './api.ts';
import styles from './OptionCard.module.css';

export type OptionCardProps = {
  option: ProposalOptionView;
  /** True only while the proposal is a draft and the person may edit it. */
  editable: boolean;
  /** 'estimate' puts the "Estimate" label beside the total. */
  basis: MeasurementKind;
  /** The company price book. Null when the person cannot read it: the saved total is shown and nothing re-prices. */
  prices: Pricebook | null;
  /** Called with only what changed, when a change is committed (switch, select, blur). */
  onChange: (patch: OptionPatch) => void;
};

/** The measured quantities the add-ons are charged against, taken from a saved scope. */
export function quantitiesFor(scope: Scope): MeasuredQuantities {
  return {
    squares: toSurfaceArea(scope.areaSqFt, scope.areaType, scope.pitch) / 100,
    edgeFt: scope.edgeFt,
    ridgeFt: scope.ridgeFt,
    valleyFt: scope.valleyFt,
  };
}

type Draft = {
  name: string;
  material: Scope['material'];
  waste: string;
  markup: string;
  addOns: AddOn[];
  rates: string[];
  enabled: boolean;
};

const centsToText = (cents: number): string => String(cents / 100);
const clamp = (text: string, max: number, fallback: number): number => {
  const n = Number(text);
  if (text.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(0, n));
};

function draftOf(option: ProposalOptionView): Draft {
  return {
    name: option.name,
    material: option.scope.material,
    waste: String(option.scope.wastePercent),
    markup: String(option.scope.markupPercent),
    addOns: option.addOns,
    rates: option.addOns.map((a) => centsToText(a.rateCents)),
    enabled: option.enabled,
  };
}

const signatureOf = (option: ProposalOptionView): string =>
  JSON.stringify([option.id, option.name, option.scope, option.addOns, option.enabled, option.totalCents]);

const unitOptions = ADD_ON_UNITS.map((unit) => ({ value: unit, label: proposals.addOnUnitLabel[unit] }));
const materialOptions = (Object.keys(materialNames) as Scope['material'][]).map((key) => ({ value: key, label: materialNames[key] }));

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function OptionCard({ option, editable, basis, prices, onChange }: OptionCardProps) {
  const signature = signatureOf(option);
  const [seen, setSeen] = useState(signature);
  const [draft, setDraft] = useState<Draft>(() => draftOf(option));
  // What the server last accepted from this card; a commit only fires when the draft differs from it.
  const [saved, setSaved] = useState<Draft>(() => draftOf(option));
  if (seen !== signature) {
    setSeen(signature);
    setDraft(draftOf(option));
    setSaved(draftOf(option));
  }

  const waste = clamp(draft.waste, 50, option.scope.wastePercent);
  const markup = clamp(draft.markup, 100, option.scope.markupPercent);

  const live = useMemo(() => {
    if (!prices) return null;
    const sc = option.scope;
    const rest = { areaSqFt: sc.areaSqFt, areaType: sc.areaType, pitch: sc.pitch, stories: sc.stories, layers: sc.layers, ridgeFt: sc.ridgeFt, edgeFt: sc.edgeFt, valleyFt: sc.valleyFt, deckingSheets: sc.deckingSheets, taxPercent: sc.taxPercent };
    try {
      return priceTier(
        { tier: option.tier, name: draft.name, material: draft.material, wastePercent: waste, markupPercent: markup, addOns: draft.addOns, highlights: option.highlights, enabled: draft.enabled },
        { ...rest, markupPercent: markup },
        prices,
        quantitiesFor(option.scope),
      );
    } catch {
      return null;
    }
  }, [prices, option, draft.name, draft.material, draft.addOns, draft.enabled, waste, markup]);

  const totalCents = live ? live.totalCents : option.totalCents;
  const lines = live ? live.calculation.lines : option.calculation.lines;
  const showMonthly = option.monthlyEstimateCents !== null && totalCents === option.totalCents;
  const estimate = basis === 'estimate';

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const commitAddOns = (addOns: AddOn[], rates: string[]) => {
    setDraft((d) => ({ ...d, addOns, rates }));
    setSaved((s) => ({ ...s, addOns, rates }));
    onChange({ addOns });
  };
  const changeAddOn = (index: number, patch: Partial<AddOn>) => {
    const addOns = draft.addOns.map((a, i) => (i === index ? { ...a, ...patch } : a));
    commitAddOns(addOns, draft.rates);
  };
  const blurAddOnText = () => {
    if (JSON.stringify(draft.addOns) !== JSON.stringify(saved.addOns)) commitAddOns(draft.addOns, draft.rates);
  };

  return (
    <Card as="section" className={styles.card} aria-label={proposals.optionHeading(option.tier)}>
      <div className={styles.header}>
        <h3 className={styles.title}>{proposals.tierName[option.tier]}</h3>
        {editable ? (
          <Toggle
            checked={draft.enabled}
            label={proposals.optionOn}
            labelHidden
            onChange={(enabled) => {
              update({ enabled });
              setSaved((s) => ({ ...s, enabled }));
              onChange({ enabled });
            }}
          />
        ) : (
          <Pill tone={option.enabled ? 'accent' : 'neutral'}>{option.enabled ? proposals.optionOn : proposals.optionOff}</Pill>
        )}
      </div>

      {option.highlights.length > 0 ? (
        <>
          <p className={styles.heading}>{proposals.includes}</p>
          <ul className={styles.highlights}>
            {option.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>
        </>
      ) : null}

      <div className={styles.totalRow}>
        <span className={styles.heading}>{proposals.totalLabel}</span>
        <span className={styles.total}>{proposals.money(totalCents)}</span>
        {estimate ? <span className={styles.estimate}>{proposals.estimateLabel}</span> : null}
      </div>
      {showMonthly && option.monthlyEstimateCents !== null ? (
        <p className={styles.monthly}>
          <span>{proposals.monthly(option.monthlyEstimateCents)}</span>
          {estimate ? <span className={styles.estimate}>{proposals.estimateLabel}</span> : null}
        </p>
      ) : null}
      {prices ? null : <p className={styles.note}>{proposals.pricesUnavailable}</p>}

      {editable ? (
        <div className={styles.fields}>
          <Field
            label={proposals.fieldName}
            value={draft.name}
            onChange={(e) => update({ name: e.currentTarget.value })}
            onBlur={() => {
              const name = draft.name.trim();
              if (name === '') return update({ name: saved.name });
              if (name !== saved.name) {
                setSaved((s) => ({ ...s, name }));
                onChange({ name });
              }
            }}
          />
          <Select
            label={proposals.fieldMaterial}
            value={draft.material}
            options={materialOptions}
            onChange={(value) => {
              const material = value as Scope['material'];
              update({ material });
              if (material !== saved.material) {
                setSaved((s) => ({ ...s, material }));
                onChange({ material });
              }
            }}
          />
          <Field
            label={proposals.fieldWaste}
            type="number"
            inputMode="decimal"
            value={draft.waste}
            onChange={(e) => update({ waste: e.currentTarget.value })}
            onBlur={() => {
              const wastePercent = clamp(draft.waste, 50, Number(saved.waste));
              update({ waste: String(wastePercent) });
              if (wastePercent !== Number(saved.waste)) {
                setSaved((s) => ({ ...s, waste: String(wastePercent) }));
                onChange({ wastePercent });
              }
            }}
          />
          <Field
            label={proposals.fieldMarkup}
            type="number"
            inputMode="decimal"
            value={draft.markup}
            onChange={(e) => update({ markup: e.currentTarget.value })}
            onBlur={() => {
              const markupPercent = clamp(draft.markup, 100, Number(saved.markup));
              update({ markup: String(markupPercent) });
              if (markupPercent !== Number(saved.markup)) {
                setSaved((s) => ({ ...s, markup: String(markupPercent) }));
                onChange({ markupPercent });
              }
            }}
          />
        </div>
      ) : (
        <dl className={styles.readList}>
          <dd>{draft.name}</dd>
          <dd>{materialNames[draft.material]}</dd>
        </dl>
      )}

      <p className={styles.heading}>{proposals.linesHeading}</p>
      <ul className={styles.lines}>
        {lines.map((line, i) => (
          <li key={`${line.code}-${i}`} className={styles.line}>
            <span className={styles.lineName}>{line.name}</span>
            <span>{proposals.money(line.totalCents)}</span>
          </li>
        ))}
      </ul>

      <p className={styles.heading}>{proposals.addOnsHeading}</p>
      {draft.addOns.length === 0 ? <p className={styles.note}>{proposals.addOnsNone}</p> : null}
      {editable ? (
        <>
          <ul className={styles.addOns}>
            {draft.addOns.map((addOn, index) => (
              <li key={index} className={styles.addOn}>
                <Field
                  label={proposals.addOnName}
                  value={addOn.name}
                  onChange={(e) => {
                    const name = e.currentTarget.value;
                    update({ addOns: draft.addOns.map((a, i) => (i === index ? { ...a, name } : a)) });
                  }}
                  onBlur={blurAddOnText}
                />
                <Select
                  label={proposals.addOnUnit}
                  value={addOn.unit}
                  options={unitOptions}
                  onChange={(unit) => changeAddOn(index, { unit: unit as AddOnUnit })}
                />
                <Field
                  label={proposals.addOnRate}
                  type="number"
                  inputMode="decimal"
                  value={draft.rates[index] ?? ''}
                  onChange={(e) => {
                    const text = e.currentTarget.value;
                    const dollars = Number(text);
                    const rateCents = text.trim() !== '' && Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : addOn.rateCents;
                    update({
                      rates: draft.rates.map((r, i) => (i === index ? text : r)),
                      addOns: draft.addOns.map((a, i) => (i === index ? { ...a, rateCents } : a)),
                    });
                  }}
                  onBlur={blurAddOnText}
                />
                <div className={styles.addOnActions}>
                  <Toggle checked={addOn.taxable} label={proposals.addOnTaxable} onChange={(taxable) => changeAddOn(index, { taxable })} />
                  <IconButton
                    label={proposals.addOnRemove(addOn.name)}
                    icon={<RemoveIcon />}
                    onClick={() =>
                      commitAddOns(
                        draft.addOns.filter((_, i) => i !== index),
                        draft.rates.filter((_, i) => i !== index),
                      )
                    }
                  />
                </div>
              </li>
            ))}
          </ul>
          <Button
            variant="ghost"
            onClick={() =>
              commitAddOns(
                [...draft.addOns, { name: proposals.addOnNewName, unit: 'per_job', rateCents: 0, taxable: false }],
                [...draft.rates, '0'],
              )
            }
          >
            {proposals.addOnAdd}
          </Button>
        </>
      ) : (
        <ul className={styles.lines}>
          {draft.addOns.map((addOn, index) => (
            <li key={index} className={styles.line}>
              <span className={styles.lineName}>{addOn.name}</span>
              <span>{proposals.addOnUnitLabel[addOn.unit]}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
