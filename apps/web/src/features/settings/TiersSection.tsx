import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ADD_ON_UNITS, TIERS, TierTemplateSchema, type AddOnUnit, type Tier, type TierTemplate } from '@roofline/shared';
import { Banner, Button, Card, Checkbox, EmptyState, Field, Select, Skeleton, Toggle, useToast, type SelectOption } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { useMe } from '../../api/hooks.ts';
import { errors } from '../../copy/errors.ts';
import { settings } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { tierEditor } from '../../copy/tiersEditor.ts';
import { useSaveTierTemplates, useTierTemplates } from './estimator-api.ts';
import styles from './TiersSection.module.css';

/*
 * Settings, Prices: the Good, Better, Best templates (E1 Task 18). Only the owner edits. Office reads.
 * Numbers are typed as text while a person types them, so a half-typed "1." is not lost, and are
 * checked against TierTemplateSchema before a save.
 */

const MATERIALS: readonly TierTemplate['material'][] = ['architectural', 'premium', 'metal'];
const MATERIAL_OPTIONS: SelectOption[] = MATERIALS.map((material) => ({ value: material, label: tierEditor.materials[material] }));
const UNIT_OPTIONS: SelectOption[] = ADD_ON_UNITS.map((unit) => ({ value: unit, label: tierEditor.units[unit] }));
const MAX_ADD_ONS = 8;
const MAX_HIGHLIGHTS = 4;

/** A draft row gets an id so React keeps the right input when a row above it is removed. */
let lastId = 0;
function nextId(): number {
  lastId += 1;
  return lastId;
}

type AddOnDraft = { id: number; name: string; unit: AddOnUnit; rate: string; taxable: boolean };
type HighlightDraft = { id: number; text: string };
type TierDraft = {
  name: string;
  material: TierTemplate['material'];
  waste: string;
  /** Empty means no markup of its own: the company default applies (null on the template). */
  markup: string;
  addOns: AddOnDraft[];
  highlights: HighlightDraft[];
  enabled: boolean;
};
type Drafts = Record<Tier, TierDraft>;
type Change = (draft: TierDraft) => TierDraft;

/** The templates in the order good, better, best, or undefined when one of the three is missing. */
function orderTemplates(templates: TierTemplate[]): TierTemplate[] | undefined {
  const ordered = TIERS.map((tier) => templates.find((template) => template.tier === tier));
  return ordered.every((template): template is TierTemplate => template !== undefined) ? ordered : undefined;
}

function toDraft(template: TierTemplate): TierDraft {
  return {
    name: template.name,
    material: template.material,
    waste: String(template.wastePercent),
    markup: template.markupPercent === null ? '' : String(template.markupPercent),
    addOns: template.addOns.map((addOn) => ({
      id: nextId(),
      name: addOn.name,
      unit: addOn.unit,
      rate: (addOn.rateCents / 100).toFixed(2),
      taxable: addOn.taxable,
    })),
    highlights: template.highlights.map((text) => ({ id: nextId(), text })),
    enabled: template.enabled,
  };
}

function toDrafts(templates: readonly TierTemplate[]): Drafts {
  const drafts = {} as Drafts;
  for (const template of templates) drafts[template.tier] = toDraft(template);
  return drafts;
}

/** Text to a number. Empty text is not zero: it is NaN, which the schema refuses. */
function toNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/** Dollars typed to cents. Rounding keeps 0.1 * 100 from becoming 10.000000000000002. */
function toCents(text: string): number {
  return Math.round(toNumber(text) * 100);
}

/** What the schema checks: the draft in the template's own shape. */
function toCandidate(tier: Tier, draft: TierDraft): unknown {
  return {
    tier,
    name: draft.name,
    material: draft.material,
    wastePercent: toNumber(draft.waste),
    markupPercent: draft.markup.trim() === '' ? null : toNumber(draft.markup),
    addOns: draft.addOns.map((addOn) => ({ name: addOn.name, unit: addOn.unit, rateCents: toCents(addOn.rate), taxable: addOn.taxable })),
    highlights: draft.highlights.map((highlight) => highlight.text),
    enabled: draft.enabled,
  };
}

/** The key of a field's error: the tier, then the path the schema gives, e.g. good.addOns.0.rateCents. */
function fieldKey(tier: Tier, path: readonly unknown[]): string {
  return [tier, ...path.map(String)].join('.');
}

/** The words for a schema problem at this path. Anything the copy does not name is a plain general message. */
function messageFor(path: readonly unknown[]): string {
  const [head, second, third] = path;
  switch (head) {
    case 'name':
      return tierEditor.errors.name;
    case 'material':
      return tierEditor.errors.material;
    case 'wastePercent':
      return tierEditor.errors.waste;
    case 'markupPercent':
      return tierEditor.errors.markup;
    case 'highlights':
      return second === undefined ? tierEditor.errors.highlightsMax : tierEditor.errors.highlight;
    case 'addOns':
      if (second === undefined) return tierEditor.errors.addOnsMax;
      if (third === 'name') return tierEditor.errors.addOnName;
      if (third === 'unit') return tierEditor.errors.addOnUnit;
      if (third === 'rateCents') return tierEditor.errors.addOnRate;
      return errors.generic;
    default:
      return errors.generic;
  }
}

type Validation = { templates: TierTemplate[] } | { errors: Record<string, string> };

/** Checks each tier with the shared schema. Nothing is sent unless all three pass. */
function validate(drafts: Drafts): Validation {
  const problems: Record<string, string> = {};
  const templates: TierTemplate[] = [];
  for (const tier of TIERS) {
    const result = TierTemplateSchema.safeParse(toCandidate(tier, drafts[tier]));
    if (result.success) {
      templates.push(result.data);
      continue;
    }
    for (const issue of result.error.issues) {
      const key = fieldKey(tier, issue.path);
      if (!(key in problems)) problems[key] = messageFor(issue.path);
    }
  }
  return Object.keys(problems).length === 0 ? { templates } : { errors: problems };
}

/** The field a server message names, in our keys: templates.1.name is better.name; good.name stays. */
function serverKey(field: string): string | undefined {
  const indexed = /^templates\.(\d+)\.(.+)$/.exec(field);
  if (indexed) {
    const tier = TIERS[Number(indexed[1])];
    return tier === undefined ? undefined : `${tier}.${indexed[2]}`;
  }
  return TIERS.some((tier) => field.startsWith(`${tier}.`)) ? field : undefined;
}

/** The section: a heading, then the loading line, the failure, or the three editors. */
function Section({ children }: { children: ReactNode }) {
  const headingId = useId();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {tierEditor.title}
      </h2>
      {children}
    </section>
  );
}

/** Good, Better, Best: the owner's templates. It loads the templates and the role, then shows the form. */
export function TiersSection() {
  const me = useMe();
  const templates = useTierTemplates();
  const ordered = templates.data ? orderTemplates(templates.data.templates) : undefined;

  if (ordered === undefined || me.data === undefined) {
    const failed = templates.isError || me.isError || (templates.data !== undefined && ordered === undefined);
    if (!failed) {
      return (
        <Section>
          <div role="status">
            <Skeleton lines={6} />
            <span className="visually-hidden">{settings.loading}</span>
          </div>
        </Section>
      );
    }
    return (
      <Section>
        <EmptyState
          title={tiers.loadFailed}
          action={
            <Button
              variant="primary"
              onClick={() => {
                void templates.refetch();
                void me.refetch();
              }}
            >
              {tiers.retry}
            </Button>
          }
        />
      </Section>
    );
  }

  return (
    <Section>
      <TiersForm templates={ordered} canEdit={me.data.role === 'owner'} />
    </Section>
  );
}

function TiersForm({ templates, canEdit }: { templates: TierTemplate[]; canEdit: boolean }) {
  const [drafts, setDrafts] = useState<Drafts>(() => toDrafts(templates));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | undefined>(undefined);
  const save = useSaveTierTemplates();
  const toast = useToast();

  /** A change clears that tier's messages: they may be about rows that have moved or been fixed. */
  function edit(tier: Tier, change: Change) {
    setDrafts((current) => ({ ...current, [tier]: change(current[tier]) }));
    setFieldErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${tier}.`))));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    const checked = validate(drafts);
    setGeneral(undefined);
    if ('errors' in checked) {
      setFieldErrors(checked.errors);
      return;
    }
    setFieldErrors({});
    save.mutate(checked.templates, {
      onSuccess: (answer) => {
        // The server's answer is what is now saved: show it, in case it tidied a value
        const next = orderTemplates(answer.templates);
        if (next !== undefined) setDrafts(toDrafts(next));
        toast.show(tiers.saved, 'success');
      },
      onError: (error) => {
        // A message about one of these fields sits under it; anything else is a banner
        const key = error instanceof ApiError && error.field !== undefined ? serverKey(error.field) : undefined;
        if (key !== undefined) setFieldErrors({ [key]: error.message });
        else setGeneral(error instanceof ApiError ? error.message : errors.generic);
      },
    });
  }

  return (
    <>
      {canEdit ? null : <p className={styles.note}>{tiers.officeReadOnly}</p>}
      {general !== undefined ? <Banner tone="danger">{general}</Banner> : null}
      <form className={styles.form} onSubmit={submit} noValidate>
        <p className={styles.intro}>{tierEditor.intro}</p>
        {TIERS.map((tier) => (
          <TierEditor
            key={tier}
            tier={tier}
            draft={drafts[tier]}
            errors={fieldErrors}
            canEdit={canEdit}
            onChange={(change) => edit(tier, change)}
          />
        ))}
        {canEdit ? (
          <Button className={styles.save} type="submit" variant="primary" busy={save.isPending}>
            {tiers.save}
          </Button>
        ) : null}
      </form>
    </>
  );
}

type EditorProps = {
  tier: Tier;
  draft: TierDraft;
  errors: Record<string, string>;
  canEdit: boolean;
  onChange: (change: Change) => void;
};

/** One option: its name, material, waste, markup, add-ons, highlights and whether it is offered. */
function TierEditor({ tier, draft, errors, canEdit, onChange }: EditorProps) {
  const error = (...path: (string | number)[]) => errors[fieldKey(tier, path)];
  const set = (patch: Partial<TierDraft>) => onChange((current) => ({ ...current, ...patch }));
  const setAddOn = (id: number, patch: Partial<AddOnDraft>) =>
    onChange((current) => ({
      ...current,
      addOns: current.addOns.map((addOn) => (addOn.id === id ? { ...addOn, ...patch } : addOn)),
    }));
  const setHighlight = (id: number, text: string) =>
    onChange((current) => ({
      ...current,
      highlights: current.highlights.map((highlight) => (highlight.id === id ? { ...highlight, text } : highlight)),
    }));

  return (
    <Card as="section" aria-label={tierEditor.regionLabels[tier]} className={styles.tier}>
      <h3 className={styles.tierHeading}>{tierEditor.tierLabels[tier]}</h3>
      <div className={styles.grid}>
        <Field
          label={tierEditor.fields.name}
          value={draft.name}
          disabled={!canEdit}
          error={error('name')}
          onChange={(event) => set({ name: event.target.value })}
        />
        <Select
          label={tierEditor.fields.material}
          value={draft.material}
          options={MATERIAL_OPTIONS}
          disabled={!canEdit}
          error={error('material')}
          onChange={(value) => set({ material: value as TierTemplate['material'] })}
        />
        <Field
          label={tierEditor.fields.waste}
          inputMode="decimal"
          value={draft.waste}
          disabled={!canEdit}
          error={error('wastePercent')}
          onChange={(event) => set({ waste: event.target.value })}
        />
        <Field
          label={tierEditor.fields.markup}
          inputMode="decimal"
          value={draft.markup}
          help={tierEditor.help.markup}
          disabled={!canEdit}
          error={error('markupPercent')}
          onChange={(event) => set({ markup: event.target.value })}
        />
      </div>
      <div className={styles.toggle}>
        <Toggle label={tierEditor.fields.enabled} checked={draft.enabled} disabled={!canEdit} onChange={(enabled) => set({ enabled })} />
      </div>

      <h4 className={styles.subheading}>{tierEditor.fields.addOns}</h4>
      {draft.addOns.map((addOn, index) => (
        <div key={addOn.id} className={styles.row}>
          <Field
            label={tierEditor.fields.addOnName}
            value={addOn.name}
            disabled={!canEdit}
            error={error('addOns', index, 'name')}
            onChange={(event) => setAddOn(addOn.id, { name: event.target.value })}
          />
          <Select
            label={tierEditor.fields.addOnUnit}
            value={addOn.unit}
            options={UNIT_OPTIONS}
            disabled={!canEdit}
            error={error('addOns', index, 'unit')}
            onChange={(value) => setAddOn(addOn.id, { unit: value as AddOnUnit })}
          />
          <Field
            label={tierEditor.fields.addOnRate}
            inputMode="decimal"
            value={addOn.rate}
            disabled={!canEdit}
            error={error('addOns', index, 'rateCents')}
            onChange={(event) => setAddOn(addOn.id, { rate: event.target.value })}
          />
          <div className={styles.toggle}>
            <Checkbox label={tierEditor.fields.taxable} checked={addOn.taxable} disabled={!canEdit} onChange={(taxable) => setAddOn(addOn.id, { taxable })} />
          </div>
          <div className={styles.rowAction}>
            <Button
              variant="ghost"
              disabled={!canEdit}
              onClick={() => onChange((current) => ({ ...current, addOns: current.addOns.filter((item) => item.id !== addOn.id) }))}
            >
              {tierEditor.removeAddOn}
            </Button>
          </div>
        </div>
      ))}
      <div className={styles.rowAction}>
        <Button
          variant="ghost"
          disabled={!canEdit || draft.addOns.length >= MAX_ADD_ONS}
          onClick={() =>
            onChange((current) => ({
              ...current,
              addOns: [...current.addOns, { id: nextId(), name: '', unit: ADD_ON_UNITS[0], rate: '', taxable: false }],
            }))
          }
        >
          {tierEditor.addAddOn}
        </Button>
      </div>

      <h4 className={styles.subheading}>{tierEditor.fields.highlights}</h4>
      {draft.highlights.map((highlight, index) => (
        <div key={highlight.id} className={styles.highlightRow}>
          <Field
            label={tierEditor.fields.highlight}
            value={highlight.text}
            disabled={!canEdit}
            error={error('highlights', index)}
            onChange={(event) => setHighlight(highlight.id, event.target.value)}
          />
          <div className={styles.rowAction}>
            <Button
              variant="ghost"
              disabled={!canEdit}
              onClick={() => onChange((current) => ({ ...current, highlights: current.highlights.filter((item) => item.id !== highlight.id) }))}
            >
              {tierEditor.removeHighlight}
            </Button>
          </div>
        </div>
      ))}
      <div className={styles.rowAction}>
        <Button
          variant="ghost"
          disabled={!canEdit || draft.highlights.length >= MAX_HIGHLIGHTS}
          onClick={() => onChange((current) => ({ ...current, highlights: [...current.highlights, { id: nextId(), text: '' }] }))}
        >
          {tierEditor.addHighlight}
        </Button>
      </div>
    </Card>
  );
}
