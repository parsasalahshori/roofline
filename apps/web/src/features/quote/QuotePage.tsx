import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Banner, Button, Checkbox, Field, Skeleton } from '@roofline/ui';
import type { PublicQuoteConfig, PublicQuoteSlot, QuoteProduct } from '@roofline/shared';
import { quote } from '../../copy/quote.ts';
import { formatPhone } from '../../lib/phone.ts';
import { ScanOverlay } from '../measure/lift/ScanOverlay.tsx';
import { readScanMs, stageAt, type ScanStage } from '../measure/lift/scan.ts';
import { type EstimateAnswer, QuoteApiError, quoteApi } from './api.ts';
import { RoofThumb } from './RoofThumb.tsx';
import styles from './QuotePage.module.css';

/*
 * The public instant quote page (/q/:slug), signed out and without the app's shell: address -> the scan while the
 * home is measured -> price ranges -> the request form -> thanks. Phone first; one column. The scan reuses the
 * Measure look (brackets and sweep, the same four stages and 4.8 s), over the home's satellite photo once the
 * answer is in. Nothing personal is ever put in the address bar.
 */

type Step =
  | { kind: 'address'; error?: AddressError }
  | { kind: 'measuring'; startedAt: number; answer: EstimateAnswer | null }
  | { kind: 'results'; answer: EstimateAnswer; showForm: boolean }
  | { kind: 'done'; firstName: string; booked: { start: string; end: string } | null };

const TICK_MS = 80;

type AddressError = { message: string; field?: string };

function useConfig(slug: string) {
  const [state, setState] = useState<{ data?: PublicQuoteConfig; error?: QuoteApiError; attempt: number }>({ attempt: 0 });
  useEffect(() => {
    const controller = new AbortController();
    quoteApi.config(slug, controller.signal).then(
      (data) => setState((s) => ({ data, attempt: s.attempt })),
      (error: unknown) => {
        if (error instanceof QuoteApiError) setState((s) => ({ error, attempt: s.attempt }));
      },
    );
    return () => controller.abort();
  }, [slug, state.attempt]);
  return { ...state, retry: () => setState((s) => ({ attempt: s.attempt + 1 })) };
}

/** The page's accent colour as CSS variables (the default when the company set none). */
function brandStyle(color: string | null): CSSProperties | undefined {
  return color === null ? undefined : ({ '--quote-accent': color } as CSSProperties);
}

export function QuotePage({ slug }: { slug: string }) {
  const config = useConfig(slug);
  const [step, setStep] = useState<Step>({ kind: 'address' });
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (config.data) document.title = quote.pageTitle(config.data.companyName);
  }, [config.data]);

  if (config.error) {
    const missing = config.error.status === 404;
    return (
      <main className={styles.page}>
        <div className={styles.column}>
          <h1 className={styles.title}>{missing ? quote.notFoundTitle : quote.loadFailed}</h1>
          {missing ? <p className={styles.text}>{quote.notFoundBody}</p> : <Button onClick={config.retry}>{quote.retry}</Button>}
        </div>
      </main>
    );
  }
  if (!config.data) {
    return (
      <main className={styles.page}>
        <div className={styles.column} role="status">
          <span className="visually-hidden">{quote.loading}</span>
          <Skeleton lines={3} />
        </div>
      </main>
    );
  }
  const c = config.data;

  return (
    <div className={styles.page} style={brandStyle(c.accentColor)}>
      <header className={styles.brand}>
        {c.logoUrl ? <img className={styles.logo} src={c.logoUrl} alt={c.companyName} /> : <span className={styles.companyName}>{c.companyName}</span>}
        {c.phone ? (
          <a className={styles.phone} href={`tel:${c.phone}`}>
            {formatPhone(c.phone)}
          </a>
        ) : null}
      </header>
      <main className={styles.column}>
        {step.kind === 'address' ? (
          <AddressStep
            slug={slug}
            address={typed}
            onAddress={setTyped}
            initialError={step.error ?? null}
            onStart={(startedAt) => setStep({ kind: 'measuring', startedAt, answer: null })}
            onAnswer={(answer) => setStep((s) => (s.kind === 'measuring' ? { ...s, answer } : s))}
            onFailed={(error) => setStep({ kind: 'address', error })}
          />
        ) : null}
        {step.kind === 'measuring' ? (
          <Measuring step={step} onDone={(answer) => setStep({ kind: 'results', answer, showForm: answer.status === 'fallback' })} />
        ) : null}
        {step.kind === 'results' ? (
          <>
            <Results
              answer={step.answer}
              onContinue={() => setStep({ ...step, showForm: true })}
              showContinue={!step.showForm}
              onStartOver={() => setStep({ kind: 'address' })}
            />
            {step.showForm ? (
              <LeadForm
                slug={slug}
                config={c}
                answer={step.answer}
                onDone={(firstName, booked) => setStep({ kind: 'done', firstName, booked })}
              />
            ) : null}
          </>
        ) : null}
        {step.kind === 'done' ? <Done config={c} firstName={step.firstName} booked={step.booked} /> : null}
      </main>
    </div>
  );
}

/** The estimate's request starts here; its answer is handed up while the scan plays, a failure brings the step back. */
function AddressStep({
  slug,
  address,
  onAddress,
  initialError,
  onStart,
  onAnswer,
  onFailed,
}: {
  slug: string;
  address: string;
  onAddress: (v: string) => void;
  initialError: AddressError | null;
  onStart: (at: number) => void;
  onAnswer: (a: EstimateAnswer) => void;
  onFailed: (e: AddressError) => void;
}) {
  const setAddress = onAddress;
  const [honeypot, setHoneypot] = useState('');
  const [error, setError] = useState<AddressError | null>(initialError);
  const headingId = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = address.trim();
    if (typed.length < 5) {
      setError({ message: quote.addressRequired, field: 'address' });
      return;
    }
    setError(null);
    onStart(performance.now());
    quoteApi.estimate(slug, { address: typed, website: honeypot }).then(onAnswer, (err: unknown) => {
      onFailed(
        err instanceof QuoteApiError
          ? { message: err.status === 429 ? quote.tooFast : err.message, ...(err.field !== undefined && { field: err.field }) }
          : { message: quote.genericError },
      );
    });
  }

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h1 id={headingId} className={styles.title}>
        {quote.heading}
      </h1>
      <p className={styles.text}>{quote.intro}</p>
      <form className={styles.addressForm} onSubmit={submit} noValidate>
        {error && error.field !== 'address' ? <Banner tone="danger">{error.message}</Banner> : null}
        <Field
          label={quote.addressLabel}
          name="address"
          autoComplete="street-address"
          placeholder={quote.addressPlaceholder}
          help={quote.addressHelp}
          value={address}
          error={error?.field === 'address' ? error.message : undefined}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={200}
          enterKeyHint="go"
        />
        <Honeypot value={honeypot} onChange={setHoneypot} />
        <Button type="submit" size="lg" className={styles.primary}>
          {quote.measureButton}
        </Button>
        <p className={styles.small}>{quote.noObligation}</p>
      </form>
    </section>
  );
}

/** A field people never see or reach; a bot that fills it is answered as if all went well, and nothing is kept. */
function Honeypot({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className={styles.honeypot} aria-hidden="true">
      <label>
        {quote.honeypotLabel}
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

function Measuring({ step, onDone }: { step: Extract<Step, { kind: 'measuring' }>; onDone: (a: EstimateAnswer) => void }) {
  const totalMs = readScanMs();
  const [elapsed, setElapsed] = useState(0);
  const done = useRef(false);
  useEffect(() => {
    const id = window.setInterval(() => setElapsed(performance.now() - step.startedAt), TICK_MS);
    return () => window.clearInterval(id);
  }, [step.startedAt]);
  // The scan plays its full length; a slow measurement holds it on the last stage until the answer is in.
  const progress = Math.min(1, elapsed / Math.max(1, totalMs));
  const answer = step.answer;
  useEffect(() => {
    if (!done.current && answer !== null && elapsed >= totalMs) {
      done.current = true;
      onDone(answer);
    }
  }, [answer, elapsed, totalMs, onDone]);
  const stage: ScanStage = stageAt(answer === null ? Math.min(progress, 0.99) : progress);
  const outline = answer?.outline ?? null;
  const box = { left: '20%', top: '15%', width: '60%', height: '70%' };
  return (
    <section className={styles.card} aria-busy="true">
      <h1 className={styles.title} role="status">
        {quote.measuringTitle}
      </h1>
      <div className={styles.scanFrame}>
        {outline !== null ? (
          <RoofThumb ring={outline.ring} center={outline.center} alt={quote.outlineAlt} showOutline={progress > 0.55}>
            <ScanOverlay box={box} sweeping={progress < 1} />
          </RoofThumb>
        ) : (
          <div className={styles.thumbPlaceholder}>
            <ScanOverlay box={box} sweeping />
          </div>
        )}
      </div>
      <ol className={styles.stages}>
        {(['finding', 'tracing', 'reading', 'pricing'] as const).map((s) => (
          <li key={s} data-state={s === stage ? 'now' : stageIndex(s) < stageIndex(stage) ? 'done' : 'next'}>
            {quote.stages[s]}
          </li>
        ))}
      </ol>
      <p className={styles.timer} aria-hidden="true">
        {quote.seconds(elapsed / 1000)}
      </p>
    </section>
  );
}

const stageIndex = (s: ScanStage) => ['finding', 'tracing', 'reading', 'pricing'].indexOf(s);

function Results({ answer, onContinue, showContinue, onStartOver }: { answer: EstimateAnswer; onContinue: () => void; showContinue: boolean; onStartOver: () => void }) {
  const headingId = useId();
  if (answer.status === 'fallback') {
    return (
      <section className={styles.card} aria-labelledby={headingId}>
        <h1 id={headingId} className={styles.title}>
          {quote.fallbackTitle}
        </h1>
        <p className={styles.text}>{quote.fallbackBody}</p>
        {answer.address !== '' ? <p className={styles.small}>{quote.forAddress(answer.address)}</p> : null}
      </section>
    );
  }
  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h1 id={headingId} className={styles.title}>
        {quote.resultsTitle}
      </h1>
      <p className={styles.small}>{quote.forAddress(answer.address)}</p>
      {answer.outline !== null ? (
        <div className={styles.scanFrame}>
          <RoofThumb ring={answer.outline.ring} center={answer.outline.center} alt={quote.outlineAlt} showOutline />
          <p className={styles.credit}>{quote.imagery}</p>
        </div>
      ) : null}
      <ul className={styles.ranges}>
        {answer.windows ? (
          <li>
            <span className={styles.rangeLabel}>{quote.windowsLine(answer.windows.count)}</span>
            <span className={styles.rangeValue}>{quote.range(answer.windows.range.lowCents, answer.windows.range.highCents)}</span>
          </li>
        ) : null}
        {answer.roof ? (
          <li>
            <span className={styles.rangeLabel}>{quote.roofLine(answer.roof.squares)}</span>
            <span className={styles.rangeValue}>{quote.range(answer.roof.range.lowCents, answer.roof.range.highCents)}</span>
          </li>
        ) : null}
        {answer.gutters ? (
          <li>
            <span className={styles.rangeLabel}>{quote.guttersLine(answer.gutters.feet)}</span>
            <span className={styles.rangeValue}>{quote.range(answer.gutters.range.lowCents, answer.gutters.range.highCents)}</span>
          </li>
        ) : null}
      </ul>
      <p className={styles.note}>{quote.finalNote}</p>
      {showContinue ? (
        <div className={styles.actions}>
          <Button size="lg" className={styles.primary} onClick={onContinue}>
            {quote.continueButton}
          </Button>
          <Button variant="ghost" onClick={onStartOver}>
            {quote.startOver}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

type FormState = { firstName: string; lastName: string; email: string; phone: string; postalCode: string; products: QuoteProduct[]; consent: boolean; slotId: string; website: string };
type FormKey = 'firstName' | 'lastName' | 'email' | 'phone' | 'postalCode' | 'products' | 'consent';

/** The checks the server makes too, so most mistakes are shown before anything is sent. */
export function checkLead(f: FormState): Partial<Record<FormKey, string>> {
  const e: Partial<Record<FormKey, string>> = {};
  if (f.firstName.trim() === '') e.firstName = quote.required(quote.firstName);
  if (f.lastName.trim() === '') e.lastName = quote.required(quote.lastName);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) e.email = quote.emailInvalid;
  const digits = f.phone.replace(/\D/g, '');
  if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) e.phone = quote.phoneInvalid;
  if (!/^\d{5}(?:-\d{4})?$/.test(f.postalCode.trim())) e.postalCode = quote.zipInvalid;
  if (f.products.length === 0) e.products = quote.productsRequired;
  if (!f.consent) e.consent = quote.consentRequired;
  return e;
}

/** The ZIP at the end of the found address, to fill the field in. */
const zipOf = (address: string) => /\b(\d{5})(?:-\d{4})?\s*$/.exec(address)?.[1] ?? '';

function LeadForm({
  slug,
  config,
  answer,
  onDone,
}: {
  slug: string;
  config: PublicQuoteConfig;
  answer: EstimateAnswer;
  onDone: (firstName: string, booked: { start: string; end: string } | null) => void;
}) {
  // Products with a range shown are ticked; with nothing measured (fallback), every product the page offers is.
  const shown: QuoteProduct[] = config.products.filter((p) => (p === 'roof' ? answer.roof : p === 'windows' ? answer.windows : answer.gutters) !== null);
  const [form, setForm] = useState<FormState>({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    postalCode: zipOf(answer.address),
    products: shown.length > 0 ? shown : [...config.products],
    consent: false,
    slotId: '',
    website: '',
  });
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState<QuoteApiError | null>(null);
  const [slots, setSlots] = useState<{ timeZone: string; slots: PublicQuoteSlot[] } | null>(null);
  const firstRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    firstRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!config.booking) return;
    const controller = new AbortController();
    quoteApi.slots(slug, controller.signal).then(setSlots, () => setSlots({ timeZone: 'UTC', slots: [] }));
    return () => controller.abort();
  }, [config.booking, slug]);

  const clientErrors = submitted ? checkLead(form) : {};
  const fieldError = (k: FormKey) => clientErrors[k] ?? (serverError?.field === k ? serverError.message : undefined);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    setServerError(null);
    if (Object.keys(checkLead(form)).length > 0) return;
    setSending(true);
    quoteApi
      .lead(slug, {
        quoteId: answer.quoteId,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
        postalCode: form.postalCode.trim(),
        products: form.products,
        consent: true,
        consentVersion: config.consent.version,
        formToken: answer.formToken,
        website: form.website,
        ...(form.slotId !== '' && { slotId: form.slotId }),
      })
      .then(
        (res) => onDone(form.firstName.trim(), res.booked),
        (err: unknown) => {
          setSending(false);
          setServerError(err instanceof QuoteApiError ? (err.status === 429 ? new QuoteApiError(429, quote.tooFast) : err) : new QuoteApiError(0, quote.genericError));
        },
      );
  }

  const fmt = (iso: string, zone: string) =>
    new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone });

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.subtitle}>
        {quote.formTitle}
      </h2>
      <form className={styles.leadForm} onSubmit={submit} noValidate>
        {serverError && serverError.field === undefined ? <Banner tone="danger">{serverError.message}</Banner> : null}
        <div className={styles.twoUp}>
          <Field ref={firstRef} label={quote.firstName} name="firstName" autoComplete="given-name" value={form.firstName} error={fieldError('firstName')} onChange={(e) => set('firstName', e.target.value)} maxLength={60} />
          <Field label={quote.lastName} name="lastName" autoComplete="family-name" value={form.lastName} error={fieldError('lastName')} onChange={(e) => set('lastName', e.target.value)} maxLength={60} />
        </div>
        <Field label={quote.email} name="email" type="email" autoComplete="email" inputMode="email" value={form.email} error={fieldError('email')} onChange={(e) => set('email', e.target.value)} maxLength={254} />
        <div className={styles.twoUp}>
          <Field label={quote.phone} name="phone" type="tel" autoComplete="tel" inputMode="tel" value={form.phone} error={fieldError('phone')} onChange={(e) => set('phone', e.target.value)} maxLength={30} />
          <Field label={quote.postalCode} name="postalCode" autoComplete="postal-code" inputMode="numeric" value={form.postalCode} error={fieldError('postalCode')} onChange={(e) => set('postalCode', e.target.value)} maxLength={10} />
        </div>
        <fieldset className={styles.products}>
          <legend className={styles.legend}>{quote.pickProducts}</legend>
          {config.products.map((p) => (
            <Checkbox
              key={p}
              checked={form.products.includes(p)}
              onChange={(on) => set('products', on ? config.products.filter((x) => x === p || form.products.includes(x)) : form.products.filter((x) => x !== p))}
              label={quote.productName(p)}
            />
          ))}
          {fieldError('products') ? (
            <p className={styles.error} role="alert">
              {fieldError('products')}
            </p>
          ) : null}
        </fieldset>
        {config.booking ? (
          <fieldset className={styles.products}>
            <legend className={styles.legend}>{quote.slotsTitle}</legend>
            {slots === null ? (
              <p className={styles.small} role="status">
                {quote.slotsLoading}
              </p>
            ) : slots.slots.length === 0 ? (
              <p className={styles.small}>{quote.slotsNone}</p>
            ) : (
              <div className={styles.slots}>
                {[{ id: '', label: quote.slotNone }, ...slots.slots.map((s) => ({ id: s.id, label: fmt(s.start, slots.timeZone) }))].map((s) => (
                  <label key={s.id === '' ? 'none' : s.id} className={styles.slot} data-checked={form.slotId === s.id ? true : undefined}>
                    <input type="radio" name="slot" value={s.id} checked={form.slotId === s.id} onChange={() => set('slotId', s.id)} />
                    {s.label}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        ) : null}
        <Checkbox checked={form.consent} onChange={(on) => set('consent', on)} label={quote.consentLabel} description={config.consent.text} error={fieldError('consent')} />
        <Honeypot value={form.website} onChange={(v) => set('website', v)} />
        <Button type="submit" size="lg" className={styles.primary} busy={sending}>
          {sending ? quote.sending : quote.submit}
        </Button>
        <p className={styles.small}>{quote.finalNote}</p>
      </form>
    </section>
  );
}

function Done({ config, firstName, booked }: { config: PublicQuoteConfig; firstName: string; booked: { start: string; end: string } | null }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const when = booked ? new Date(booked.start).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  return (
    <section className={styles.card}>
      <div className={styles.check} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </div>
      <h1 ref={ref} tabIndex={-1} className={styles.title}>
        {quote.doneTitle(firstName)}
      </h1>
      <p className={styles.text}>{when === null ? quote.doneBody : quote.doneBodyBooked}</p>
      {when !== null ? <p className={styles.text}>{quote.doneBooked(when)}</p> : null}
      {config.phone ? <p className={styles.small}>{quote.doneCall(formatPhone(config.phone))}</p> : null}
    </section>
  );
}
