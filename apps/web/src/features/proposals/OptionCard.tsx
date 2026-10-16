import { useMemo, useState } from 'react';
import { ADD_ON_UNITS, materialNames, priceTier, toSurfaceArea } from '@roofline/shared';
import type { AddOn, MeasuredQuantities, MeasurementKind, Pricebook, ProposalOptionView, Scope, Tier } from '@roofline/shared';
import { Button, Field, Icon, IconButton, Listbox, Table, Tag, Td, Th, Toggle, Tr } from '@roofline/ui';
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
  /** True for the option that is picked: it shows what it includes, its fields, its price lines and its total. */
  open?: boolean;
  /**
   * Given on a desktop, where the three options are stacked rows and each row is a radio that picks it. Left out on a
   * phone, where the tabs above pick the option and the row is only a heading.
   */
  onSelect?: () => void;
  /** The name the three rows' radios share, so the arrow keys move between them. */
  radioName?: string;
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

/** The option the pages call out: the one most people choose. The job page and the measure screen follow the same rule. */
const RECOMMENDED_TIER: Tier = 'better';

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function OptionCard({ option, editable, basis, prices, onChange, open = true, onSelect, radioName }: OptionCardProps) {
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

  const recommended = option.tier === RECOMMENDED_TIER;
  const title = (
    <>
      {onSelect ? <span className={styles.radio} aria-hidden="true" /> : null}
      <span className={styles.titles}>
        <span className={styles.tierLine}>
          <span className={styles.tier}>{proposals.tierName[option.tier]}</span>
          {recommended ? (
            <Tag tone="brand" icon="star">
              {proposals.recommended}
            </Tag>
          ) : null}
          {draft.enabled ? null : (
            <Tag tone="neutral" icon="minus">
              {proposals.optionLeftOut}
            </Tag>
          )}
        </span>
        <span className={styles.name}>{draft.name}</span>
        <span className={styles.spec}>{proposals.specLine(materialNames[draft.material], waste)}</span>
      </span>
      {onSelect ? <span className={styles.price}>{proposals.money(totalCents)}</span> : null}
    </>
  );

  return (
    <section
      aria-label={proposals.optionHeading(option.tier)}
      className={styles.card}
      data-recommended={recommended ? 'true' : undefined}
      data-open={open ? 'true' : 'false'}
    >
      {onSelect ? (
        <label className={styles.header} data-pick="true">
          <input type="radio" name={radioName} className={styles.input} checked={open} onChange={onSelect} />
          {title}
        </label>
      ) : (
        <div className={styles.header}>{title}</div>
      )}

      <div className={styles.detail} hidden={!open}>
        <div className={styles.body}>
          {editable ? (
            <Toggle
              checked={draft.enabled}
              label={proposals.optionOn}
              onChange={(enabled) => {
                update({ enabled });
                setSaved((s) => ({ ...s, enabled }));
                onChange({ enabled });
              }}
            />
          ) : null}

          {option.highlights.length > 0 ? (
            <section className={styles.block}>
              <p className={styles.heading}>{proposals.includes}</p>
              <ul className={styles.highlights}>
                {option.highlights.map((h, i) => (
                  <li key={i}>
                    <Icon name="check" size={16} />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {editable ? (
            <div className={styles.fields}>
              <Field
                className={styles.wide}
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
              <Listbox
                className={styles.wide}
                label={proposals.fieldMaterial}
                value={draft.material}
                options={materialOptions}
                onChange={(material) => {
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
          ) : null}

          <section className={styles.block}>
            <p className={styles.heading}>{proposals.linesHeading}</p>
            <div className={styles.flush}>
              <Table>
                <thead>
                  <tr>
                    <Th>{proposals.lineItem}</Th>
                    <Th numeric>{proposals.lineAmount}</Th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <Tr key={`${line.code}-${i}`}>
                      <Td>{line.name}</Td>
                      <Td numeric>{proposals.money(line.totalCents)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </section>

          <section className={styles.block}>
            <p className={styles.heading}>{proposals.addOnsHeading}</p>
            {draft.addOns.length === 0 ? <p className={styles.note}>{proposals.addOnsNone}</p> : null}
            {editable ? (
              <>
                <ul className={styles.addOns}>
                  {draft.addOns.map((addOn, index) => (
                    <li key={index} className={styles.addOn}>
                      <Field
                        className={styles.addOnName}
                        label={proposals.addOnName}
                        value={addOn.name}
                        onChange={(e) => {
                          const name = e.currentTarget.value;
                          update({ addOns: draft.addOns.map((a, i) => (i === index ? { ...a, name } : a)) });
                        }}
                        onBlur={blurAddOnText}
                      />
                      <Listbox label={proposals.addOnUnit} value={addOn.unit} options={unitOptions} onChange={(unit) => changeAddOn(index, { unit })} />
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
                  variant="default"
                  size="sm"
                  className={styles.addButton}
                  onClick={() =>
                    commitAddOns(
                      [...draft.addOns, { name: proposals.addOnNewName, unit: 'per_job', rateCents: 0, taxable: false }],
                      [...draft.rates, '0'],
                    )
                  }
                >
                  <Icon name="plus" size={16} />
                  {proposals.addOnAdd}
                </Button>
              </>
            ) : draft.addOns.length > 0 ? (
              <div className={styles.flush}>
                <Table>
                  <thead>
                    <tr>
                      <Th>{proposals.lineItem}</Th>
                      <Th>{proposals.addOnUnit}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {draft.addOns.map((addOn, index) => (
                      <Tr key={index}>
                        <Td>{addOn.name}</Td>
                        <Td>{proposals.addOnUnitLabel[addOn.unit]}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            ) : null}
          </section>
        </div>

        {/* The total is pinned to the foot of the card while its lines scroll: the lines above add up to it */}
        <div className={styles.foot}>
          <span className={styles.footLabel}>{proposals.totalLabel}</span>
          <span className={styles.total}>{proposals.money(totalCents)}</span>
          {estimate ? <Tag>{proposals.estimateLabel}</Tag> : null}
          {showMonthly && option.monthlyEstimateCents !== null ? (
            <span className={styles.monthly}>
              {proposals.monthly(option.monthlyEstimateCents)}
              {estimate ? <Tag>{proposals.estimateLabel}</Tag> : null}
            </span>
          ) : null}
          {prices ? null : <span className={styles.note}>{proposals.pricesUnavailable}</span>}
        </div>
      </div>
    </section>
  );
}
