import { useId, useState, type FormEvent } from 'react';
import { Banner, Button, Checkbox, EmptyState, Field, Skeleton, Toggle, useToast } from '@roofline/ui';
import { QUOTE_PRODUCTS, type InstantQuoteSettings, type QuoteProduct } from '@roofline/shared';
import { useMe } from '../../api/hooks.ts';
import { quote, quoteSettings as copy } from '../../copy/quote.ts';
import { settings as settingsCopy } from '../../copy/settings.ts';
import { tiers } from '../../copy/tiers.ts';
import { formErrors } from '../auth/formErrors.ts';
import { embedSnippet } from '../quote/embed.ts';
import styles from './FinanceEstimate.module.css';
import { type InstantQuoteSettingsView, useInstantQuoteSettings, useSaveInstantQuoteSettings } from './quote-api.ts';

const FIELDS = ['slug', 'products', 'rangePct', 'dailyCap', 'embedOrigins', 'accentColor'] as const;

type Form = { enabled: boolean; slug: string; products: QuoteProduct[]; rangePct: string; dailyCap: string; origins: string; booking: boolean; accentColor: string };

const toForm = (s: InstantQuoteSettings): Form => ({
  enabled: s.enabled,
  slug: s.slug ?? '',
  products: s.products,
  rangePct: String(s.rangePct),
  dailyCap: String(s.dailyCap),
  origins: s.embedOrigins.join('\n'),
  booking: s.booking,
  accentColor: s.accentColor ?? '',
});

/** The form as the API takes it. Numbers that are not numbers go as NaN and come back as the server's field message. */
const toBody = (f: Form): InstantQuoteSettings => ({
  enabled: f.enabled,
  slug: f.slug.trim() === '' ? null : f.slug.trim().toLowerCase(),
  products: f.products,
  rangePct: Number(f.rangePct),
  dailyCap: Number(f.dailyCap),
  embedOrigins: f.origins
    .split(/[\s,]+/)
    .map((o) => o.trim())
    .filter((o) => o !== ''),
  booking: f.booking,
  accentColor: f.accentColor.trim() === '' ? null : f.accentColor.trim(),
});

/** Settings -> Prices -> Instant quote page: the owner turns the public page on, sets it up and copies the embed code. */
export function InstantQuoteSection() {
  const headingId = useId();
  const me = useMe();
  const query = useInstantQuoteSettings();
  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        {copy.title}
      </h2>
      <p className={styles.note}>{copy.intro}</p>
      {query.data !== undefined && me.data !== undefined ? (
        <QuoteForm settings={query.data} canEdit={me.data.role === 'owner'} />
      ) : query.error ? (
        <EmptyState
          title={tiers.loadFailed}
          action={
            <Button variant="primary" onClick={() => void query.refetch()}>
              {tiers.retry}
            </Button>
          }
        />
      ) : (
        <div role="status">
          <Skeleton lines={3} />
          <span className="visually-hidden">{settingsCopy.loading}</span>
        </div>
      )}
    </section>
  );
}

function QuoteForm({ settings, canEdit }: { settings: InstantQuoteSettingsView; canEdit: boolean }) {
  const [form, setForm] = useState(() => toForm(settings));
  const [copied, setCopied] = useState(false);
  const save = useSaveInstantQuoteSettings();
  const toast = useToast();
  const problems = formErrors(save.error, FIELDS);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const saved = save.data ?? settings;
  const snippet = saved.enabled && saved.pageUrl !== null ? embedSnippet(saved.pageUrl, copy.iframeTitle) : null;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canEdit) return;
    save.mutate(toBody(form), {
      onSuccess: (answer) => {
        setForm(toForm(answer));
        toast.show(copy.saved, 'success');
      },
    });
  }

  return (
    <>
      {canEdit ? null : <p className={styles.note}>{copy.officeReadOnly}</p>}
      <form className={styles.form} onSubmit={submit} noValidate>
        {problems.general ? (
          <div className={styles.banner}>
            <Banner tone="danger">{problems.general}</Banner>
          </div>
        ) : null}
        <div className={styles.switch}>
          <Toggle label={copy.enabled} checked={form.enabled} onChange={(v) => set('enabled', v)} disabled={!canEdit} />
        </div>
        <Field
          label={copy.slug}
          name="slug"
          help={copy.slugHelp(origin)}
          value={form.slug}
          onChange={(e) => set('slug', e.target.value)}
          disabled={!canEdit}
          error={problems.forField('slug')}
          autoCapitalize="none"
          spellCheck={false}
          maxLength={40}
        />
        <Field
          label={copy.accentColor}
          name="accentColor"
          help={copy.accentHelp}
          value={form.accentColor}
          onChange={(e) => set('accentColor', e.target.value)}
          disabled={!canEdit}
          error={problems.forField('accentColor')}
          maxLength={7}
        />
        <fieldset className={styles.switch}>
          <legend className={styles.heading}>{copy.products}</legend>
          {QUOTE_PRODUCTS.map((p) => (
            <Checkbox
              key={p}
              checked={form.products.includes(p)}
              onChange={(on) => set('products', on ? QUOTE_PRODUCTS.filter((x) => x === p || form.products.includes(x)) : form.products.filter((x) => x !== p))}
              label={quote.productName(p)}
              disabled={!canEdit}
            />
          ))}
          {problems.forField('products') ? <p className={styles.help}>{problems.forField('products')}</p> : null}
        </fieldset>
        <Field
          label={copy.rangePct}
          name="rangePct"
          type="number"
          inputMode="numeric"
          min="5"
          max="40"
          help={copy.rangeHelp}
          value={form.rangePct}
          onChange={(e) => set('rangePct', e.target.value)}
          disabled={!canEdit}
          error={problems.forField('rangePct')}
        />
        <Field
          label={copy.dailyCap}
          name="dailyCap"
          type="number"
          inputMode="numeric"
          min="0"
          max="1000"
          help={copy.dailyCapHelp}
          value={form.dailyCap}
          onChange={(e) => set('dailyCap', e.target.value)}
          disabled={!canEdit}
          error={problems.forField('dailyCap')}
        />
        <Field
          className={styles.switch}
          label={copy.embedOrigins}
          name="embedOrigins"
          multiline
          rows={3}
          help={copy.embedOriginsHelp}
          value={form.origins}
          onChange={(e) => set('origins', e.target.value)}
          disabled={!canEdit}
          error={problems.forField('embedOrigins')}
        />
        <div className={styles.switch}>
          <Toggle label={copy.booking} checked={form.booking} onChange={(v) => set('booking', v)} disabled={!canEdit} />
        </div>
        {canEdit ? (
          <Button type="submit" variant="primary" className={styles.save} busy={save.isPending}>
            {copy.save}
          </Button>
        ) : null}
      </form>
      <div className={styles.section}>
        <h3 className={styles.heading}>{copy.embedTitle}</h3>
        {snippet === null ? (
          <p className={styles.help}>{copy.turnOnFirst}</p>
        ) : (
          <>
            <p className={styles.help}>{copy.embedHelp}</p>
            <Field label={copy.embedTitle} labelHidden name="embedSnippet" multiline rows={8} readOnly value={snippet} onFocus={(e) => e.target.select()} />
            <div className={styles.buttons}>
              <Button
                variant="ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(snippet).then(() => setCopied(true));
                }}
              >
                {copied ? copy.copied : copy.copy}
              </Button>
              <a className={styles.previewLink} href={saved.pageUrl ?? '#'} target="_blank" rel="noopener noreferrer">
                {copy.preview}
              </a>
            </div>
          </>
        )}
      </div>
    </>
  );
}
