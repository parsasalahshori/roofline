import { useState, type FormEvent } from 'react';
import type { Pricebook, PricebookView } from '@roofline/shared';
import { Banner, Button, EmptyState, Field, Icon, Listbox, Panel, Skeleton, Table, Tag, Td, Th, Tr, useToast, type ListboxOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { prices } from '../../copy/prices.ts';
import { formErrors } from '../auth/formErrors.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { usePricebook, useSavePricebook, type PricebookSave } from './crm-api.ts';
import { EstimateSection } from './EstimateSection.tsx';
import { FactoryOrdersSection } from './FactoryOrdersSection.tsx';
import { InstantQuoteSection } from './InstantQuoteSection.tsx';
import { FinancingSection } from './FinancingSection.tsx';
import form from './form.module.css';
import styles from './PricesTab.module.css';
import { SaveBar } from './SaveBar.tsx';
import { TiersSection } from './TiersSection.tsx';

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

const MATERIAL_OPTIONS: readonly ListboxOption<Material>[] = MATERIALS.map((material) => ({
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

/** The Prices tab: C1's price list, then E1's Estimator sections (each loads its own data). */
export function PricesTab() {
  return (
    <>
      <PricebookPart />
      {/* E1 Task 14: Estimator sections, kept apart from C1's price list above */}
      <TiersSection />
      <FinancingSection />
      <EstimateSection />
      <InstantQuoteSection />
      <FactoryOrdersSection />
    </>
  );
}

/** The price list and quote defaults. The owner edits them; everyone else reads them. */
function PricebookPart() {
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
      <Panel>
        <div role="status">
          <Skeleton lines={6} />
          <span className="visually-hidden">{prices.loading}</span>
        </div>
      </Panel>
    );
  }

  return <PricesForm view={pricebook.data} canEdit={me.data.role === 'owner'} />;
}

/** Dollars the way a price list shows them: $1,250.00, so the cents line up down a column. */
const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** What the box holds, shown as the table shows it. Empty counts as zero, as it does when saved. */
function shown(kind: 'money' | 'percent', text: string): string {
  const amount = text.trim() === '' ? 0 : Number(text);
  if (!Number.isFinite(amount)) return text;
  return kind === 'money' ? DOLLARS.format(amount) : `${amount}%`;
}

/** The key a server message names, without its `prices.` or `defaults.` start: `prices.permit` is `permit`. */
const rowOf = (path: string) => path.replace(/^(prices|defaults)\./, '');

type RowProps = {
  label: string;
  unit: string;
  /** A phone has no room for a column of units: each goes under its price's name. */
  unitUnderName: boolean;
  /** The amount as a box holds it, and as it was last saved. */
  value: string;
  saved: string;
  kind: 'money' | 'percent';
  open: boolean;
  canEdit: boolean;
  error: string | undefined;
  onToggle: () => void;
  onChange: (next: string) => void;
};

/** One price: its name, what it is per, and the amount in mono at the right. The owner opens a row to change its amount. */
function PriceRow({ label, unit, unitUnderName, value, saved, kind, open, canEdit, error, onToggle, onChange }: RowProps) {
  const edited = value !== saved;
  return (
    <Tr tone={edited ? 'brand' : undefined}>
      <Td>
        <span className={styles.label}>
          {label}
          {edited ? (
            <Tag tone="brand" icon="pen">
              {prices.edited}
            </Tag>
          ) : null}
        </span>
        {unitUnderName ? <span className={styles.unitUnder}>{unit}</span> : null}
      </Td>
      {unitUnderName ? null : <Td className={styles.unit}>{unit}</Td>}
      <Td numeric>
        {open ? (
          <Field
            className={styles.amount}
            label={label}
            labelHidden
            name={label}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            error={error}
          />
        ) : (
          shown(kind, value)
        )}
      </Td>
      <Td className={styles.action}>
        {canEdit ? (
          <Button variant="ghost" size="sm" aria-expanded={open} aria-label={open ? prices.doneFor(label) : prices.editFor(label)} onClick={onToggle}>
            {open ? prices.done : prices.edit}
          </Button>
        ) : null}
      </Td>
    </Tr>
  );
}

function PricesForm({ view, canEdit }: { view: PricebookView; canEdit: boolean }) {
  const [values, setValues] = useState(() => toForm(view));
  // The values the form was last loaded or saved with: only a difference from these makes Save work
  const [baseline, setBaseline] = useState(() => toForm(view));
  const [example, setExample] = useState(view.isExample);
  // The rows whose amount is open for typing
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const phone = useIsPhone();
  const save = useSavePricebook();
  const toast = useToast();
  const problems = formErrors(save.error, FIELD_PATHS);
  const changed = differs(values, baseline);

  function setNumber(key: PriceKey | DefaultNumberKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function toggle(key: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit || !changed) return;
    save.mutate(toBody(values), {
      onSuccess: (saved) => {
        // The server's answer is what is now saved: show it, and the example note goes away once it is not an example
        const next = toForm(saved);
        setBaseline(next);
        setValues(next);
        setExample(saved.isExample);
        setOpen(new Set());
        toast.show(prices.saved, 'success');
      },
      onError: (error) => {
        // A message about one of these fields sits under it, in a row opened for the purpose; anything else is a toast
        const found = formErrors(error, FIELD_PATHS);
        const named = FIELD_PATHS.filter((path) => found.forField(path) !== undefined).map(rowOf);
        if (named.length > 0) setOpen((current) => new Set([...current, ...named]));
        if (found.general) toast.show(found.general, 'error');
      },
    });
  }

  const tableHead = (
    <thead>
      <tr>
        <Th>{prices.columns.item}</Th>
        {phone ? null : <Th>{prices.columns.unit}</Th>}
        <Th numeric>{prices.columns.price}</Th>
        <Th>
          <span className="visually-hidden">{prices.columns.actions}</span>
        </Th>
      </tr>
    </thead>
  );

  const tableFor = (title: string, rows: readonly Row[]) => (
    <Panel key={title} title={title} padded={false}>
      <Table className={styles.prices} regionLabel={title}>
        {tableHead}
        <tbody>
          {rows.map((row) => (
            <PriceRow
              key={row.key}
              label={prices.fields[row.key]}
              unit={row.help}
              unitUnderName={phone}
              value={values[row.key]}
              saved={baseline[row.key]}
              kind="money"
              open={open.has(row.key)}
              canEdit={canEdit}
              error={problems.forField(`prices.${row.key}`)}
              onToggle={() => toggle(row.key)}
              onChange={(next) => setNumber(row.key, next)}
            />
          ))}
        </tbody>
      </Table>
    </Panel>
  );

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      {example ? <Banner tone="info">{prices.exampleBanner}</Banner> : null}
      {canEdit ? null : (
        <p className={form.note}>
          <Icon name="lock" size={16} />
          {prices.ownerOnly}
        </p>
      )}
      {GROUPS.map((group) => tableFor(group.title, group.rows))}
      <Panel title={prices.groups.defaults} padded={false}>
        <Table className={styles.prices} regionLabel={prices.groups.defaults}>
          {tableHead}
          <tbody>
            {DEFAULT_NUMBER_KEYS.map((key) => (
              <PriceRow
                key={key}
                label={prices.fields[key]}
                unit={prices.units.percent}
                unitUnderName={phone}
                value={values[key]}
                saved={baseline[key]}
                kind="percent"
                open={open.has(key)}
                canEdit={canEdit}
                error={problems.forField(`defaults.${key}`)}
                onToggle={() => toggle(key)}
                onChange={(next) => setNumber(key, next)}
              />
            ))}
            <Tr tone={values.material !== baseline.material ? 'brand' : undefined}>
              <Td>
                <span className={styles.label}>
                  {prices.fields.material}
                  {values.material !== baseline.material ? (
                    <Tag tone="brand" icon="pen">
                      {prices.edited}
                    </Tag>
                  ) : null}
                </span>
              </Td>
              {phone ? null : <Td className={styles.unit} />}
              <Td numeric className={styles.material}>
                {canEdit ? (
                  <Listbox
                    className={styles.materialList}
                    label={prices.fields.material}
                    value={values.material}
                    options={MATERIAL_OPTIONS}
                    onChange={(material) => setValues((current) => ({ ...current, material }))}
                    error={problems.forField('defaults.material')}
                  />
                ) : (
                  prices.materialOptions[values.material]
                )}
              </Td>
              <Td className={styles.action} />
            </Tr>
          </tbody>
        </Table>
      </Panel>
      {canEdit ? (
        <SaveBar
          dirty={changed}
          saving={save.isPending}
          saveLabel={prices.save}
          onDiscard={() => {
            save.reset();
            setValues(baseline);
            setOpen(new Set());
          }}
        />
      ) : null}
    </form>
  );
}
