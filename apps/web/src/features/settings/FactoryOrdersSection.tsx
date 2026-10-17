import { useState, type FormEvent, type ReactNode } from 'react';
import {
  DEFAULT_WINDOW_ORDER_SETTINGS,
  ORDER_ROUNDING_STEPS,
  WINDOW_STYLES,
  type OrderRounding,
  type StyleLimits,
  type WindowOrderSettings,
  type WindowOrderSettingsPatch,
  type WindowStyle,
} from '@roofline/shared';
import { Banner, Button, EmptyState, Field, Icon, Listbox, Panel, Skeleton, useToast, type ListboxOption } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { factoryOrders as copy } from '../../copy/factoryOrders.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { formErrors } from '../auth/formErrors.ts';
import shared from './FinanceEstimate.module.css';
import styles from './FactoryOrdersSection.module.css';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';
import { useSaveWindowOrderSettings, useWindowOrderSettings } from './window-order-settings-api.ts';

/** The four plain number settings, by the key the API takes, with the range the API accepts. */
const NUMBER_KEYS = ['widthDeductionIn', 'heightDeductionIn', 'uncertaintyFactor', 'checkUncertaintyIn'] as const;
type NumberKey = (typeof NUMBER_KEYS)[number];
const NUMBER_RANGE: Record<NumberKey, [number, number]> = {
  widthDeductionIn: [0, 2],
  heightDeductionIn: [0, 2],
  uncertaintyFactor: [0, 3],
  checkUncertaintyIn: [0, 2],
};

/** One style's limits, in the order they show, with the range the API accepts. */
const LIMIT_KEYS = ['minWidthIn', 'maxWidthIn', 'minHeightIn', 'maxHeightIn', 'maxUnitedIn', 'maxAreaSqFt', 'maxTemperedAreaSqFt'] as const satisfies readonly (keyof StyleLimits)[];
type LimitKey = (typeof LIMIT_KEYS)[number];
const LIMIT_RANGE: Record<LimitKey, [number, number]> = {
  minWidthIn: [1, 240],
  maxWidthIn: [1, 240],
  minHeightIn: [1, 240],
  maxHeightIn: [1, 240],
  maxUnitedIn: [1, 480],
  maxAreaSqFt: [1, 400],
  maxTemperedAreaSqFt: [1, 400],
};

/** What the form holds: every number as the text typed, the rounding step as its option value. */
type Form = Record<NumberKey, string> & { roundingIn: string; limits: Record<WindowStyle, Record<LimitKey, string>> };

/** Error keys: a number setting's key, or `limits.<style>.<limit>`. */
const limitField = (style: WindowStyle, key: LimitKey) => `limits.${style}.${key}`;
const SERVER_FIELDS: readonly string[] = [...NUMBER_KEYS, 'roundingIn'];

const ROUNDING_OPTIONS: readonly ListboxOption[] = ORDER_ROUNDING_STEPS.map((step) => ({ value: String(step), label: copy.roundingOption(step) }));
const STYLE_OPTIONS: readonly ListboxOption<WindowStyle>[] = WINDOW_STYLES.map((style) => ({ value: style, label: copy.styleOption(style) }));

function toForm(s: WindowOrderSettings): Form {
  const limits = Object.fromEntries(
    WINDOW_STYLES.map((style) => [style, Object.fromEntries(LIMIT_KEYS.map((key) => [key, String(s.limits[style][key])]))]),
  ) as Form['limits'];
  return {
    widthDeductionIn: String(s.widthDeductionIn),
    heightDeductionIn: String(s.heightDeductionIn),
    uncertaintyFactor: String(s.uncertaintyFactor),
    checkUncertaintyIn: String(s.checkUncertaintyIn),
    roundingIn: String(s.roundingIn),
    limits,
  };
}

/** The number in `text` when it is in range, or the words to show beside the field. */
function numberOf(text: string, [min, max]: [number, number]): number | string {
  const trimmed = text.trim();
  if (trimmed === '') return copy.required;
  const value = Number(trimmed);
  if (!(Number.isFinite(value) && value >= min && value <= max)) return copy.range(min, max);
  return value;
}

type Checked = { ok: true; settings: WindowOrderSettings } | { ok: false; errors: Record<string, string> };

/** The form checked before anything is sent: the settings, or a message for every field that is wrong. */
function check(form: Form): Checked {
  const errors: Record<string, string> = {};
  const numbers = {} as Record<NumberKey, number>;
  for (const key of NUMBER_KEYS) {
    const value = numberOf(form[key], NUMBER_RANGE[key]);
    if (typeof value === 'string') errors[key] = value;
    else numbers[key] = value;
  }
  const limits = {} as Record<WindowStyle, StyleLimits>;
  for (const style of WINDOW_STYLES) {
    const one = {} as StyleLimits;
    for (const key of LIMIT_KEYS) {
      const value = numberOf(form.limits[style][key], LIMIT_RANGE[key]);
      if (typeof value === 'string') errors[limitField(style, key)] = value;
      else one[key] = value;
    }
    if (one.minWidthIn !== undefined && one.maxWidthIn !== undefined && one.minWidthIn > one.maxWidthIn) {
      errors[limitField(style, 'minWidthIn')] = copy.minOverMax;
    }
    if (one.minHeightIn !== undefined && one.maxHeightIn !== undefined && one.minHeightIn > one.maxHeightIn) {
      errors[limitField(style, 'minHeightIn')] = copy.minOverMax;
    }
    limits[style] = one;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, settings: { ...numbers, roundingIn: Number(form.roundingIn) as OrderRounding, limits } };
}

/** Only what differs from the standard values, so a later change to a standard value still reaches this company. */
export function patchOf(s: WindowOrderSettings): WindowOrderSettingsPatch {
  const d = DEFAULT_WINDOW_ORDER_SETTINGS;
  const patch: WindowOrderSettingsPatch = {};
  for (const key of NUMBER_KEYS) if (s[key] !== d[key]) patch[key] = s[key];
  if (s.roundingIn !== d.roundingIn) patch.roundingIn = s.roundingIn;
  const limits: NonNullable<WindowOrderSettingsPatch['limits']> = {};
  for (const style of WINDOW_STYLES) {
    const changed: Partial<StyleLimits> = {};
    for (const key of LIMIT_KEYS) if (s.limits[style][key] !== d.limits[style][key]) changed[key] = s.limits[style][key];
    if (Object.keys(changed).length > 0) limits[style] = changed;
  }
  if (Object.keys(limits).length > 0) patch.limits = limits;
  return patch;
}

/** The panel of the Prices tab the loading line and the failure sit in. The form brings its own panel. */
function Section({ children }: { children: ReactNode }) {
  return (
    <Panel title={copy.title}>
      <p className={shared.lead}>{copy.intro}</p>
      {children}
    </Panel>
  );
}

/** Factory orders: the order-size rule and each window style's factory limits. The owner sets them, everyone else reads them. */
export function FactoryOrdersSection() {
  const me = useMe();
  const settings = useWindowOrderSettings();

  // Shown only while there is nothing to show instead: a failed read with no earlier answer to keep
  const failure = settings.error ?? me.error;
  if (settings.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <Section>
          <EmptyState
            title={tiers.loadFailed}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void settings.refetch();
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
        <div role="status">
          <Skeleton lines={3} />
          <span className="visually-hidden">{settingsCopy.loading}</span>
        </div>
      </Section>
    );
  }

  return <FactoryOrdersForm settings={settings.data} canEdit={me.data.role === 'owner'} />;
}

function FactoryOrdersForm({ settings, canEdit }: { settings: WindowOrderSettings; canEdit: boolean }) {
  const [values, setValues] = useState(() => toForm(settings));
  // What the form was last loaded or saved as: only a difference makes it saveable
  const [baseline, setBaseline] = useState(() => toForm(settings));
  const [style, setStyle] = useState<WindowStyle>(WINDOW_STYLES[0]);
  // Problems in the form are shown once the owner has tried to save, then follow the edits as they are made
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveWindowOrderSettings();
  const toast = useToast();
  const problems = formErrors(save.error, SERVER_FIELDS);
  const current = check(values);
  const clientErrors: Record<string, string> = submitted && !current.ok ? current.errors : {};
  const changed = JSON.stringify(values) !== JSON.stringify(baseline);
  // A wrong limit of a style not on screen has no field to sit beside, so it is named at the top
  const otherStyle = WINDOW_STYLES.find((s) => s !== style && LIMIT_KEYS.some((key) => clientErrors[limitField(s, key)] !== undefined));

  function send(patch: WindowOrderSettingsPatch, saved: string) {
    save.mutate(patch, {
      onSuccess: (answer) => {
        // The answer is what the server kept: show that, not what was typed
        const next = toForm(answer);
        setValues(next);
        setBaseline(next);
        setSubmitted(false);
        toast.show(saved, 'success');
      },
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSubmitted(true);
    const checked = check(values);
    if (!checked.ok) return;
    send(patchOf(checked.settings), tiers.saved);
  }

  const setNumber = (key: NumberKey, value: string) => setValues((previous) => ({ ...previous, [key]: value }));
  const setLimit = (key: LimitKey, value: string) =>
    setValues((previous) => ({ ...previous, limits: { ...previous.limits, [style]: { ...previous.limits[style], [key]: value } } }));

  const numberField = (key: NumberKey, label: string, step: string, help?: string) => (
    <Field
      key={key}
      label={label}
      name={key}
      type="number"
      inputMode="decimal"
      step={step}
      min={String(NUMBER_RANGE[key][0])}
      max={String(NUMBER_RANGE[key][1])}
      value={values[key]}
      onChange={(event) => setNumber(key, event.target.value)}
      disabled={!canEdit}
      help={help}
      error={clientErrors[key] ?? problems.forField(key)}
    />
  );

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel
        title={copy.title}
        actions={
          canEdit ? (
            <Button variant="default" size="sm" disabled={save.isPending} onClick={() => send({}, copy.defaultsRestored)}>
              {copy.useDefaults}
            </Button>
          ) : undefined
        }
      >
        <p className={shared.lead}>{copy.intro}</p>
        {canEdit ? null : (
          <p className={form.note}>
            <Icon name="lock" size={16} />
            {tiers.officeReadOnly}
          </p>
        )}
        {problems.general ? (
          <div className={shared.banner}>
            <Banner tone="danger">{problems.general}</Banner>
          </div>
        ) : null}
        {otherStyle !== undefined ? (
          <div className={shared.banner}>
            <Banner tone="danger">{copy.otherStyleWrong(otherStyle)}</Banner>
          </div>
        ) : null}
        <div className={form.grid}>
          {numberField('widthDeductionIn', copy.widthDeduction, '0.0625', copy.deductionHelp)}
          {numberField('heightDeductionIn', copy.heightDeduction, '0.0625')}
          <Listbox
            label={copy.rounding}
            value={values.roundingIn}
            onChange={(value) => setValues((previous) => ({ ...previous, roundingIn: value }))}
            options={ROUNDING_OPTIONS}
            disabled={!canEdit}
            error={problems.forField('roundingIn')}
          />
          {numberField('uncertaintyFactor', copy.uncertaintyFactor, '0.1', copy.uncertaintyHelp)}
          {numberField('checkUncertaintyIn', copy.checkUncertainty, '0.0625')}

          <div className={`${form.span} ${styles.limits}`}>
            <h3 className={form.group}>{copy.limitsTitle}</h3>
            <p className={shared.help}>{copy.limitsHelp}</p>
          </div>
          <Listbox className={form.span} label={copy.style} value={style} onChange={setStyle} options={STYLE_OPTIONS} />
          {LIMIT_KEYS.map((key) => (
            <Field
              key={`${style}-${key}`}
              label={copy.limit[key]}
              name={limitField(style, key)}
              type="number"
              inputMode="decimal"
              step="0.125"
              min={String(LIMIT_RANGE[key][0])}
              max={String(LIMIT_RANGE[key][1])}
              value={values.limits[style][key]}
              onChange={(event) => setLimit(key, event.target.value)}
              disabled={!canEdit}
              error={clientErrors[limitField(style, key)]}
            />
          ))}
        </div>
      </Panel>
      {canEdit ? (
        <SaveBar
          dirty={changed}
          saving={save.isPending}
          saveLabel={tiers.save}
          onDiscard={() => {
            save.reset();
            setValues(baseline);
            setSubmitted(false);
          }}
        />
      ) : null}
    </form>
  );
}
