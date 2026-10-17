import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ADDER_KEYS,
  resolveCatalog,
  TIERS,
  WINDOW_CATALOG_LIMITS,
  WINDOW_SIZE_CLASSES,
  type CatalogRating,
  type StyleTile,
  type Tier,
  type WindowAdders,
  type WindowCatalog,
  type WindowSizeClass,
  type WindowTier,
} from '@roofline/shared';
import { Banner, Button, Checkbox, EmptyState, Field, Icon, Panel, Skeleton, useToast } from '@roofline/ui';
import { useMe } from '../../api/hooks.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers as tiersCopy } from '../../copy/tiers.ts';
import { windowCatalog as copy } from '../../copy/windowCatalog.ts';
import { formErrors } from '../auth/formErrors.ts';
import shared from './FinanceEstimate.module.css';
import styles from './WindowCatalogSection.module.css';
import form from './form.module.css';
import { SaveBar } from './SaveBar.tsx';
import { useSaveWindowCatalog, useWindowCatalog } from './window-catalog-api.ts';

/*
 * Settings -> Prices -> Windows catalog. One form over the whole catalog record: the form holds every number as the text
 * typed (dollars), and goes back to cents and the catalog's own shape on save.
 */

type TileForm = { id: string; label: string; hint: string; atVisit: boolean };
type TierForm = { tier: Tier; label: string; note: string; name: string; description: string; prices: Record<WindowSizeClass, string> };
type Form = {
  tiles: TileForm[];
  tiers: TierForm[];
  /** By tile id then tier: dollars (may be negative). */
  adjust: Record<string, Record<Tier, string>>;
  adders: Record<keyof WindowAdders, string>;
  included: string;
  ratingValue: string;
  ratingCount: string;
  ratingPlus: boolean;
  ratingSource: string;
  sinceYear: string;
  licenseState: string;
  licenseNumber: string;
  badges: [string, string, string];
  offerTitle: string;
  offerUrl: string;
  financingText: string;
  financingUrl: string;
};

const dollars = (cents: number): string => String(cents / 100);
const toCents = (text: string): number => Math.round(Number(text.trim()) * 100);

function toForm(c: WindowCatalog): Form {
  const tilesAll = c.styleTiles;
  return {
    tiles: tilesAll.map((t) => ({ id: t.id, label: t.label, hint: t.hint, atVisit: t.atVisit })),
    tiers: TIERS.map((tier) => {
      const t = c.tiers.find((x) => x.tier === tier)!;
      return {
        tier,
        label: t.label ?? '',
        note: t.note ?? '',
        name: t.name,
        description: t.description,
        prices: Object.fromEntries(WINDOW_SIZE_CLASSES.map((s) => [s, dollars(t.priceCents[s])])) as Record<WindowSizeClass, string>,
      };
    }),
    adjust: Object.fromEntries(tilesAll.map((t) => [t.id, Object.fromEntries(TIERS.map((tier) => [tier, dollars(c.styleAdjustCents[t.id]?.[tier] ?? 0)]))])) as Form['adjust'],
    adders: Object.fromEntries(ADDER_KEYS.map((k) => [k, dollars(c.adders[k])])) as Form['adders'],
    included: c.included.join('\n'),
    ratingValue: c.trust.rating === null ? '' : String(c.trust.rating.value),
    ratingCount: c.trust.rating === null ? '' : String(c.trust.rating.count),
    ratingPlus: c.trust.rating?.plus ?? false,
    ratingSource: c.trust.rating?.source ?? '',
    sinceYear: c.trust.sinceYear === null ? '' : String(c.trust.sinceYear),
    licenseState: c.trust.license?.state ?? '',
    licenseNumber: c.trust.license?.number ?? '',
    badges: [c.trust.badges[0] ?? '', c.trust.badges[1] ?? '', c.trust.badges[2] ?? ''],
    offerTitle: c.offer?.title ?? '',
    offerUrl: c.offer?.termsUrl ?? '',
    financingText: c.financing?.text ?? '',
    financingUrl: c.financing?.url ?? '',
  };
}

const isMoney = (text: string, min: number, max: number): boolean => {
  const t = text.trim();
  if (t === '' || !Number.isFinite(Number(t))) return false;
  const v = Number(t);
  return v >= min && v <= max;
};
const isHttps = (text: string): boolean => /^https:\/\/\S+$/.test(text.trim());

type Checked = { ok: true; catalog: WindowCatalog } | { ok: false; errors: Record<string, string> };

/** The form checked before anything is sent: the catalog, or a message for every field that is wrong. */
function check(values: Form, base: WindowCatalog): Checked {
  const errors: Record<string, string> = {};
  const L = WINDOW_CATALOG_LIMITS;

  values.tiles.forEach((t, i) => {
    if (t.label.trim() === '') errors[`tile.${i}.label`] = copy.required;
  });
  for (const t of values.tiers) {
    for (const s of WINDOW_SIZE_CLASSES) if (!isMoney(t.prices[s], 0, 10_000)) errors[`price.${t.tier}.${s}`] = isMoney(t.prices[s], -Infinity, Infinity) ? copy.moneyRange : copy.money;
    if (t.name.trim() === '') errors[`tier.${t.tier}.name`] = copy.required;
  }
  for (const [id, row] of Object.entries(values.adjust)) {
    for (const tier of TIERS) if (!isMoney(row[tier], -10_000, 10_000)) errors[`adjust.${id}.${tier}`] = isMoney(row[tier], -Infinity, Infinity) ? copy.moneyDiff : copy.money;
  }
  for (const k of ADDER_KEYS) if (!isMoney(values.adders[k], 0, 10_000)) errors[`adder.${k}`] = isMoney(values.adders[k], -Infinity, Infinity) ? copy.moneyRange : copy.money;

  const lines = values.included.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length > L.included) errors.included = copy.tooManyLines;
  else if (lines.some((l) => l.length > L.includedItem)) errors.included = copy.lineTooLong;

  const anyRating = [values.ratingValue, values.ratingCount, values.ratingSource].some((v) => v.trim() !== '');
  let rating: CatalogRating | null = null;
  if (anyRating) {
    const value = Number(values.ratingValue);
    const count = Number(values.ratingCount);
    if (!(values.ratingValue.trim() !== '' && value >= 1 && value <= 5)) errors.ratingValue = copy.ratingRange;
    if (!(values.ratingCount.trim() !== '' && Number.isInteger(count) && count >= 1)) errors.ratingCount = copy.countRange;
    if (values.ratingSource.trim() === '') errors.ratingSource = copy.needsRatingParts;
    if (!errors.ratingValue && !errors.ratingCount && !errors.ratingSource) rating = { value, count, plus: values.ratingPlus, source: values.ratingSource.trim() };
  }
  let sinceYear: number | null = null;
  if (values.sinceYear.trim() !== '') {
    const y = Number(values.sinceYear);
    if (!(Number.isInteger(y) && y >= 1900 && y <= 2100)) errors.sinceYear = copy.yearRange;
    else sinceYear = y;
  }
  let license: { state: string; number: string } | null = null;
  const anyLicense = values.licenseState.trim() !== '' || values.licenseNumber.trim() !== '';
  if (anyLicense) {
    if (!/^[A-Za-z]{2}$/.test(values.licenseState.trim())) errors.licenseState = copy.stateRange;
    if (values.licenseNumber.trim() === '') errors.licenseNumber = copy.needsBoth;
    if (!errors.licenseState && !errors.licenseNumber) license = { state: values.licenseState.trim().toUpperCase(), number: values.licenseNumber.trim() };
  }
  const badges = values.badges.map((b) => b.trim()).filter((b) => b !== '');
  values.badges.forEach((b, i) => {
    if (b.trim().length > L.badgeItem) errors[`badge.${i}`] = copy.lineTooLong;
  });

  if (values.offerTitle.trim() === '' && values.offerUrl.trim() !== '') errors.offerTitle = copy.needsBoth;
  if (values.offerUrl.trim() !== '' && !isHttps(values.offerUrl)) errors.offerUrl = copy.httpsOnly;
  if (values.financingText.trim() === '' && values.financingUrl.trim() !== '') errors.financingText = copy.needsBoth;
  if (values.financingUrl.trim() !== '' && !isHttps(values.financingUrl)) errors.financingUrl = copy.httpsOnly;

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const styleTiles: StyleTile[] = base.styleTiles.map((t, i) => ({ ...t, label: values.tiles[i]!.label.trim(), hint: values.tiles[i]!.hint.trim(), atVisit: values.tiles[i]!.atVisit }));
  const tierList: WindowTier[] = values.tiers.map((t) => {
    const was = base.tiers.find((x) => x.tier === t.tier)!;
    return {
      tier: t.tier,
      name: t.name.trim(),
      description: t.description.trim(),
      ...(t.label.trim() !== '' && { label: t.label.trim() }),
      ...(t.note.trim() !== '' && { note: t.note.trim() }),
      priceCents: Object.fromEntries(WINDOW_SIZE_CLASSES.map((s) => [s, toCents(t.prices[s])])) as Record<WindowSizeClass, number>,
      enabled: was.enabled,
    };
  });
  const styleAdjustCents: WindowCatalog['styleAdjustCents'] = {};
  for (const t of styleTiles) {
    const row = values.adjust[t.id];
    if (row === undefined) continue;
    const cents = Object.fromEntries(TIERS.map((tier) => [tier, toCents(row[tier])]).filter(([, c]) => c !== 0)) as Partial<Record<Tier, number>>;
    if (Object.keys(cents).length > 0) styleAdjustCents[t.id] = cents;
  }
  return {
    ok: true,
    catalog: {
      styleTiles,
      tiers: tierList,
      styleAdjustCents,
      adders: Object.fromEntries(ADDER_KEYS.map((k) => [k, toCents(values.adders[k])])) as WindowAdders,
      included: lines,
      trust: { rating, sinceYear, license, badges },
      offer: values.offerTitle.trim() === '' ? null : { title: values.offerTitle.trim(), termsUrl: values.offerUrl.trim() === '' ? null : values.offerUrl.trim() },
      financing: values.financingText.trim() === '' ? null : { text: values.financingText.trim(), url: values.financingUrl.trim() === '' ? null : values.financingUrl.trim() },
    },
  };
}

/** The panel of the Prices tab the loading line and the failure sit in. The form brings its own panels. */
function Section({ children }: { children: ReactNode }) {
  return (
    <Panel title={copy.title}>
      <p className={shared.lead}>{copy.intro}</p>
      {children}
    </Panel>
  );
}

/** Windows catalog: the owner sets it, office reads it. */
export function WindowCatalogSection() {
  const me = useMe();
  const catalog = useWindowCatalog();

  const failure = catalog.error ?? me.error;
  if (catalog.data === undefined || me.data === undefined) {
    if (failure) {
      return (
        <Section>
          <EmptyState
            title={tiersCopy.loadFailed}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  void catalog.refetch();
                  void me.refetch();
                }}
              >
                {tiersCopy.retry}
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
  return <WindowCatalogForm catalog={catalog.data} canEdit={me.data.role === 'owner'} />;
}

function WindowCatalogForm({ catalog, canEdit }: { catalog: WindowCatalog; canEdit: boolean }) {
  const [base, setBase] = useState(catalog);
  const [values, setValues] = useState(() => toForm(catalog));
  const [baseline, setBaseline] = useState(() => toForm(catalog));
  const [submitted, setSubmitted] = useState(false);
  const save = useSaveWindowCatalog();
  const toast = useToast();
  const problems = formErrors(save.error, []);
  const current = check(values, base);
  const errors: Record<string, string> = submitted && !current.ok ? current.errors : {};
  const changed = JSON.stringify(values) !== JSON.stringify(baseline);

  function send(next: WindowCatalog, saved: string) {
    save.mutate(next, {
      onSuccess: (answer) => {
        const f = toForm(answer);
        setBase(answer);
        setValues(f);
        setBaseline(f);
        setSubmitted(false);
        toast.show(saved, 'success');
      },
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    setSubmitted(true);
    const checked = check(values, base);
    if (checked.ok) send(checked.catalog, tiersCopy.saved);
  }

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setValues((v) => ({ ...v, [key]: value }));
  const setTile = (i: number, patch: Partial<TileForm>) => setValues((v) => ({ ...v, tiles: v.tiles.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const setTier = (tier: Tier, patch: Partial<Omit<TierForm, 'prices'>>) => setValues((v) => ({ ...v, tiers: v.tiers.map((t) => (t.tier === tier ? { ...t, ...patch } : t)) }));
  const setPrice = (tier: Tier, size: WindowSizeClass, text: string) =>
    setValues((v) => ({ ...v, tiers: v.tiers.map((t) => (t.tier === tier ? { ...t, prices: { ...t.prices, [size]: text } } : t)) }));
  const setAdjust = (id: string, tier: Tier, text: string) => setValues((v) => ({ ...v, adjust: { ...v.adjust, [id]: { ...v.adjust[id]!, [tier]: text } } }));

  const money = (label: string, value: string, onChange: (text: string) => void, error?: string) => (
    <Field label={label} labelHidden type="number" inputMode="decimal" step="1" value={value} onChange={(e) => onChange(e.target.value)} disabled={!canEdit} error={error} />
  );
  const rank = (tier: Tier) => copy.levelRank[tier];
  const tierLabel = (t: TierForm) => (t.label.trim() === '' ? rank(t.tier) : t.label.trim());

  return (
    <form className={form.form} onSubmit={submit} noValidate>
      <Panel
        title={copy.title}
        actions={
          canEdit ? (
            <Button variant="default" size="sm" disabled={save.isPending} onClick={() => send(resolveCatalog(null), copy.defaultsRestored)}>
              {copy.useDefaults}
            </Button>
          ) : undefined
        }
      >
        <p className={shared.lead}>{copy.intro}</p>
        {canEdit ? null : (
          <p className={form.note}>
            <Icon name="lock" size={16} />
            {tiersCopy.officeReadOnly}
          </p>
        )}
        {problems.general ? (
          <div className={shared.banner}>
            <Banner tone="danger">{problems.general}</Banner>
          </div>
        ) : null}

        <h3 className={form.group}>{copy.choicesTitle}</h3>
        <p className={shared.help}>{copy.choicesHelp}</p>
        <div className={form.grid} data-catalog-choices="">
          {values.tiles.map((t, i) => (
            <div key={t.id} className={`${form.span} ${styles.choice}`}>
              <Field label={copy.choiceLabel(i + 1)} value={t.label} onChange={(e) => setTile(i, { label: e.target.value })} maxLength={WINDOW_CATALOG_LIMITS.tileLabel} disabled={!canEdit} error={errors[`tile.${i}.label`]} />
              <Field label={copy.choiceHint(i + 1)} value={t.hint} onChange={(e) => setTile(i, { hint: e.target.value })} maxLength={WINDOW_CATALOG_LIMITS.tileHint} disabled={!canEdit} />
              <Checkbox checked={t.atVisit} onChange={(on) => setTile(i, { atVisit: on })} label={copy.choiceAtVisit(t.label.trim() === '' ? String(i + 1) : t.label.trim())} disabled={!canEdit} />
            </div>
          ))}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.levelsTitle}</h3>
        <p className={shared.help}>{copy.levelsHelp}</p>
        <div className={form.grid} data-catalog-levels="">
          {values.tiers.map((t) => (
            <div key={t.tier} className={`${form.span} ${styles.level}`}>
              <Field label={copy.levelLabel(rank(t.tier))} value={t.label} placeholder={rank(t.tier)} onChange={(e) => setTier(t.tier, { label: e.target.value })} maxLength={WINDOW_CATALOG_LIMITS.tierLabel} disabled={!canEdit} />
              <Field label={copy.levelNote(rank(t.tier))} value={t.note} onChange={(e) => setTier(t.tier, { note: e.target.value })} maxLength={WINDOW_CATALOG_LIMITS.tierNote} disabled={!canEdit} />
              <Field label={copy.levelName(rank(t.tier))} value={t.name} onChange={(e) => setTier(t.tier, { name: e.target.value })} maxLength={60} disabled={!canEdit} error={errors[`tier.${t.tier}.name`]} />
            </div>
          ))}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.pricesTitle}</h3>
        <p className={shared.help}>{copy.pricesHelp}</p>
        <div className={styles.table} role="table" aria-label={copy.pricesTitle} data-price-grid="">
          <div className={styles.row} role="row">
            <span role="columnheader" />
            {values.tiers.map((t) => (
              <span key={t.tier} role="columnheader" className={styles.head}>
                {tierLabel(t)}
              </span>
            ))}
          </div>
          {WINDOW_SIZE_CLASSES.map((size) => (
            <div key={size} className={styles.row} role="row">
              <span role="rowheader" className={styles.side}>
                {copy.sizeNames[size]}
              </span>
              {values.tiers.map((t) => (
                <span key={t.tier} role="cell">
                  {money(copy.priceCell(copy.sizeNames[size], tierLabel(t)), t.prices[size], (text) => setPrice(t.tier, size, text), errors[`price.${t.tier}.${size}`])}
                </span>
              ))}
            </div>
          ))}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.stylePricesTitle}</h3>
        <p className={shared.help}>{copy.stylePricesHelp}</p>
        <div className={styles.table} role="table" aria-label={copy.stylePricesTitle} data-style-grid="">
          <div className={styles.row} role="row">
            <span role="columnheader" />
            {values.tiers.map((t) => (
              <span key={t.tier} role="columnheader" className={styles.head}>
                {tierLabel(t)}
              </span>
            ))}
          </div>
          {values.tiles.map((tile) =>
            tile.atVisit ? null : (
              <div key={tile.id} className={styles.row} role="row">
                <span role="rowheader" className={styles.side}>
                  {tile.label}
                </span>
                {values.tiers.map((t) => (
                  <span key={t.tier} role="cell">
                    {money(copy.stylePriceCell(tile.label, tierLabel(t)), values.adjust[tile.id]?.[t.tier] ?? '0', (text) => setAdjust(tile.id, t.tier, text), errors[`adjust.${tile.id}.${t.tier}`])}
                  </span>
                ))}
              </div>
            ),
          )}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.addersTitle}</h3>
        <p className={shared.help}>{copy.addersHelp}</p>
        <div className={form.grid} data-catalog-adders="">
          {ADDER_KEYS.map((k) => (
            <Field
              key={k}
              label={copy.adders[k]}
              type="number"
              inputMode="decimal"
              step="1"
              value={values.adders[k]}
              onChange={(e) => set('adders', { ...values.adders, [k]: e.target.value })}
              disabled={!canEdit}
              error={errors[`adder.${k}`]}
            />
          ))}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.includedTitle}</h3>
        <Field label={copy.includedLabel} help={copy.includedHelp} multiline rows={5} value={values.included} onChange={(e) => set('included', e.target.value)} disabled={!canEdit} error={errors.included} />

        <h3 className={`${form.group} ${styles.gap}`}>{copy.trustTitle}</h3>
        <p className={shared.help}>{copy.trustHelp}</p>
        <div className={form.grid} data-catalog-trust="">
          <Field label={copy.ratingValue} type="number" inputMode="decimal" step="0.1" value={values.ratingValue} onChange={(e) => set('ratingValue', e.target.value)} disabled={!canEdit} error={errors.ratingValue} />
          <Field label={copy.ratingCount} type="number" inputMode="numeric" step="1" value={values.ratingCount} onChange={(e) => set('ratingCount', e.target.value)} disabled={!canEdit} error={errors.ratingCount} />
          <Field label={copy.ratingSource} help={copy.ratingSourceHelp} value={values.ratingSource} onChange={(e) => set('ratingSource', e.target.value)} maxLength={30} disabled={!canEdit} error={errors.ratingSource} />
          <Checkbox checked={values.ratingPlus} onChange={(on) => set('ratingPlus', on)} label={copy.ratingPlus} disabled={!canEdit} />
          <Field label={copy.sinceYear} type="number" inputMode="numeric" step="1" value={values.sinceYear} onChange={(e) => set('sinceYear', e.target.value)} disabled={!canEdit} error={errors.sinceYear} />
          <span />
          <Field label={copy.licenseState} value={values.licenseState} onChange={(e) => set('licenseState', e.target.value)} maxLength={2} disabled={!canEdit} error={errors.licenseState} />
          <Field label={copy.licenseNumber} value={values.licenseNumber} onChange={(e) => set('licenseNumber', e.target.value)} maxLength={24} disabled={!canEdit} error={errors.licenseNumber} />
          {values.badges.map((b, i) => (
            <Field
              key={i}
              label={copy.badge(i + 1)}
              help={i === 0 ? copy.badgeHelp : undefined}
              value={b}
              onChange={(e) => set('badges', values.badges.map((x, j) => (j === i ? e.target.value : x)) as Form['badges'])}
              maxLength={WINDOW_CATALOG_LIMITS.badgeItem}
              disabled={!canEdit}
              error={errors[`badge.${i}`]}
            />
          ))}
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.offerTitle}</h3>
        <p className={shared.help}>{copy.offerHelp}</p>
        <div className={form.grid} data-catalog-offer="">
          <Field label={copy.offerText} value={values.offerTitle} onChange={(e) => set('offerTitle', e.target.value)} maxLength={WINDOW_CATALOG_LIMITS.offerTitle} disabled={!canEdit} error={errors.offerTitle} />
          <Field label={copy.offerUrl} type="url" value={values.offerUrl} onChange={(e) => set('offerUrl', e.target.value)} maxLength={WINDOW_CATALOG_LIMITS.url} disabled={!canEdit} error={errors.offerUrl} />
        </div>

        <h3 className={`${form.group} ${styles.gap}`}>{copy.financingTitle}</h3>
        <p className={shared.help}>{copy.financingHelp}</p>
        <div className={form.grid} data-catalog-financing="">
          <Field label={copy.financingText} value={values.financingText} onChange={(e) => set('financingText', e.target.value)} maxLength={WINDOW_CATALOG_LIMITS.financingText} disabled={!canEdit} error={errors.financingText} />
          <Field label={copy.financingUrl} type="url" value={values.financingUrl} onChange={(e) => set('financingUrl', e.target.value)} maxLength={WINDOW_CATALOG_LIMITS.url} disabled={!canEdit} error={errors.financingUrl} />
        </div>
      </Panel>
      {canEdit ? (
        <SaveBar
          dirty={changed}
          saving={save.isPending}
          saveLabel={tiersCopy.save}
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
