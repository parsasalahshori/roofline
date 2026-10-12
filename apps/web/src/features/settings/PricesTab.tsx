import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { Pricebook, PricebookView } from '@roofline/shared';
import { Banner, Button, EmptyState, Field, Select, Skeleton, useToast, type SelectOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { prices } from '../../copy/prices.ts';
import { formErrors } from '../auth/formErrors.ts';
import { usePricebook, useSavePricebook, type PricebookSave } from './crm-api.ts';
import styles from './PricesTab.module.css';

/** The 15 pricebook keys, each a dollar amount. */
const PRICE_KEYS = [
  'architecturalBundle',
  'premiumBundle',
  'metalPerSquare',
  'laborPerSquare',
  'metalLaborPerSquare',
  'tearoffPerSquare',
  'steepPerSquare',
  'heightPerSquare',
  'ridgePerFt',
  'edgePerFt',
  'valleyPerFt',
  'underlaymentPerSquare',
  'deckingPerSheet',
  'disposal',
  'permit',
] as const satisfies readonly (keyof Pricebook)[];
type PriceKey = (typeof PRICE_KEYS)[number];

const DEFAULT_NUMBER_KEYS = ['wastePercent', 'markupPercent', 'taxPercent'] as const;
type DefaultNumberKey = (typeof DEFAULT_NUMBER_KEYS)[number];

const MATERIALS = ['architectural', 'premium', 'metal'] as const;
type Material = (typeof MATERIALS)[number];

/** What the form holds: every number as the text the person typed, and the material choice. */
type Form = Record<PriceKey | DefaultNumberKey, string> & { material: Material };

type Row = { key: PriceKey; help: string };

/** The price groups, in the order they show on screen. */
const GROUPS: readonly { title: string; rows: readonly Row[] }[] = [
  {
    title: prices.groups.materials,
    rows: [
      { key: 'architecturalBundle', help: prices.units.perBundle },
      { key: 'premiumBundle', help: prices.units.perBundle },
      { key: 'metalPerSquare', help: prices.units.perSquare },
    ],
  },
  {
    title: prices.groups.labor,
    rows: [
      { key: 'laborPerSquare', help: prices.units.perSquare },
      { key: 'metalLaborPerSquare', help: prices.units.perSquare },
      { key: 'tearoffPerSquare', help: prices.units.perSquare },
      { key: 'steepPerSquare', help: prices.units.perSquare },
      { key: 'heightPerSquare', help: prices.units.perSquare },
    ],
  },
  {
    title: prices.groups.perFoot,
    rows: [
      { key: 'ridgePerFt', help: prices.units.perFoot },
      { key: 'edgePerFt', help: prices.units.perFoot },
      { key: 'valleyPerFt', help: prices.units.perFoot },
    ],
  },
  {
    title: prices.groups.other,
    rows: [
      { key: 'underlaymentPerSquare', help: prices.units.perSquare },
      { key: 'deckingPerSheet', help: prices.units.perSheet },
      { key: 'disposal', help: prices.units.perJob },
      { key: 'permit', help: prices.units.perJob },
    ],
  },
];

const MATERIAL_OPTIONS: readonly SelectOption[] = MATERIALS.map((material) => ({
  value: material,
  label: prices.materialOptions[material],
}));

/** The field paths the server names in a 400 (`prices.permit`, `defaults.taxPercent`). */
const FIELD_PATHS: readonly string[] = [
  ...PRICE_KEYS.map((key) => `prices.${key}`),
  ...DEFAULT_NUMBER_KEYS.map((key) => `defaults.${key}`),
  'defaults.material',
];

function toForm(view: PricebookView): Form {
  const form = { material: view.defaults.material } as Form;
  for (const key of PRICE_KEYS) form[key] = String(view.prices[key]);
  for (const key of DEFAULT_NUMBER_KEYS) form[key] = String(view.defaults[key]);
  return form;
}

/** Turns the form into the `PUT /api/pricebook` body. An empty box counts as zero. */
function toBody(form: Form): PricebookSave {
  const amounts = {} as Pricebook;
  for (const key of PRICE_KEYS) amounts[key] = Number(form[key]);
  return {
    prices: amounts,
    defaults: {
      wastePercent: Number(form.wastePercent),
      markupPercent: Number(form.markupPercent),
      taxPercent: Number(form.taxPercent),
      material: form.material,
    },
  };
}

const FORM_KEYS: readonly (keyof Form)[] = [...PRICE_KEYS, ...DEFAULT_NUMBER_KEYS, 'material'];

function differs(a: Form, b: Form): boolean {
  return FORM_KEYS.some((key) => a[key] !== b[key]);
}

/** The price list and quote defaults. The owner edits them; everyone else reads them. */
export function PricesTab() {
  const me = useMe();
  const pricebook = usePricebook();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = pricebook.error ?? me.error;
  if (pricebook.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <EmptyState
          title={failure instanceof ApiError ? failure.message : prices.loadFailed}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void pricebook.refetch();
                void me.refetch();
              }}
            >
              {errors.tryAgain}
            </Button>
          }
        />
      );
    }
    return (
      <div role="status">
        <Skeleton lines={6} />
        <span className="visually-hidden">{prices.loading}</span>
      </div>
    );
  }

  return <PricesForm view={pricebook.data} canEdit={me.data.role === 'owner'} />;
}

function PricesForm({ view, canEdit }: { view: PricebookView; canEdit: boolean }) {
  const [form, setForm] = useState(() => toForm(view));
  // The values the form was last loaded or saved with: only a difference from these makes Save work
  const [baseline, setBaseline] = useState(() => toForm(view));
  const [example, setExample] = useState(view.isExample);
  const save = useSavePricebook();
  const toast = useToast();
  const problems = formErrors(save.error, FIELD_PATHS);
  const changed = differs(form, baseline);

  function setNumber(key: PriceKey | DefaultNumberKey) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setForm((current) => ({ ...current, [key]: value }));
    };
  }

  function setMaterial(value: string) {
    const material = MATERIALS.find((option) => option === value);
    if (material) setForm((current) => ({ ...current, material }));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !changed) return;
    save.mutate(toBody(form), {
      onSuccess: (saved) => {
        // The server's answer is what is now saved: show it, and the example note goes away once it is not an example
        const next = toForm(saved);
        setBaseline(next);
        setForm(next);
        setExample(saved.isExample);
        toast.show(prices.saved, 'success');
      },
      onError: (error) => {
        // A message about one of these fields sits under it; anything else is a toast
        const general = formErrors(error, FIELD_PATHS).general;
        if (general) toast.show(general, 'error');
      },
    });
  }

  return (
    <>
      {example ? <Banner tone="info">{prices.exampleBanner}</Banner> : null}
      {canEdit ? null : <p className={styles.note}>{prices.ownerOnly}</p>}
      <form className={styles.form} onSubmit={submit} noValidate>
        {GROUPS.map((group) => (
          <fieldset key={group.title} className={styles.group}>
            <legend className={styles.legend}>{group.title}</legend>
            <div className={styles.fields}>
              {group.rows.map((row) => (
                <Field
                  key={row.key}
                  label={prices.fields[row.key]}
                  name={row.key}
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  help={row.help}
                  value={form[row.key]}
                  onChange={setNumber(row.key)}
                  readOnly={!canEdit}
                  error={problems.forField(`prices.${row.key}`)}
                />
              ))}
            </div>
          </fieldset>
        ))}
        <fieldset className={styles.group}>
          <legend className={styles.legend}>{prices.groups.defaults}</legend>
          <div className={styles.fields}>
            {DEFAULT_NUMBER_KEYS.map((key) => (
              <Field
                key={key}
                label={prices.fields[key]}
                name={key}
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                help={prices.units.percent}
                value={form[key]}
                onChange={setNumber(key)}
                readOnly={!canEdit}
                error={problems.forField(`defaults.${key}`)}
              />
            ))}
            <Select
              label={prices.fields.material}
              value={form.material}
              onChange={setMaterial}
              options={MATERIAL_OPTIONS}
              disabled={!canEdit}
              error={problems.forField('defaults.material')}
            />
          </div>
        </fieldset>
        {canEdit ? (
          <Button className={styles.save} type="submit" variant="primary" busy={save.isPending} disabled={!changed}>
            {prices.save}
          </Button>
        ) : null}
      </form>
    </>
  );
}
