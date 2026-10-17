import { Banner, Button, Checkbox, Field } from '@roofline/ui';
import type { HomeownerCompany, HomeownerRequestView, HomeownerWindow, WindowStyle } from '@roofline/shared';
import { Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import { formatPhone } from '../../../lib/phone.ts';
import { useArSupport } from '../../measure/windows/ar/arSupport.ts';
import { LazyArMeasure } from '../../measure/windows/ar/lazy.ts';
import { visitTime } from '../time.ts';
import { HomeownerApiError, type HomeownerClient, type HomeownerSlots, type Session } from './api.ts';
import { CardCapture } from './CardCapture.tsx';
import { checkContact, LABEL_MAX, ROOM_MAX, roomChoices, roomCounts, windowInput, zipOf, type ContactErrors, type ContactForm, type Draft } from './flow.ts';
import q from '../QuotePage.module.css';
import styles from './MeasureFlow.module.css';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** A screen's title: takes the focus when the screen opens, so a screen reader starts at the top. */
export function Title({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <h1 ref={ref} className={q.title} tabIndex={-1}>
      {children}
    </h1>
  );
}

const messageOf = (err: unknown): string => (err instanceof HomeownerApiError ? err.message : copy.genericError);

export function Coaching({ view, onStart, onContact }: { view: HomeownerRequestView; onStart: () => void; onContact: () => void }) {
  if (view.request.status === 'callback') {
    return (
      <section className={q.card} data-screen="coaching-callback">
        <Title>{copy.coachCallback}</Title>
        <p className={q.text}>{copy.coachCallbackBody}</p>
        <Button size="lg" className={q.primary} onClick={onContact}>
          {copy.coachCallbackButton}
        </Button>
      </section>
    );
  }
  return (
    <section className={q.card} data-screen="coaching">
      <Title>{copy.coachTitle}</Title>
      <p className={q.text}>{copy.coachBody}</p>
      <ol className={styles.coachSteps}>
        {copy.coachSteps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className={q.note}>{copy.coachNote}</p>
      <Button size="lg" className={q.primary} onClick={onStart}>
        {copy.coachStart}
      </Button>
    </section>
  );
}

export function Rooms({ view, onMeasure, onSeeWindows }: { view: HomeownerRequestView; onMeasure: () => void; onSeeWindows: () => void }) {
  const rooms = roomCounts(view);
  return (
    <section className={q.card} data-screen="rooms">
      <Title>{copy.roomsTitle}</Title>
      {rooms.length === 0 ? (
        <p className={q.text}>{copy.roomsEmpty}</p>
      ) : (
        <ul className={styles.list} data-rooms="">
          {rooms.map((r) => (
            <li key={r.room} className={styles.listRow}>
              <strong>{r.room}</strong>
              <span className={q.small}>{copy.roomsCount(r.count)}</span>
            </li>
          ))}
        </ul>
      )}
      <Button size="lg" className={q.primary} onClick={onMeasure}>
        {copy.roomsMeasure}
      </Button>
      {view.windows.length > 0 ? (
        <Button variant="ghost" className={q.secondary} onClick={onSeeWindows}>
          {copy.roomsDone}
        </Button>
      ) : null}
    </section>
  );
}

export function MeasureWindow({
  client,
  session,
  company,
  windowId,
  onDone,
  onBack,
}: {
  client: HomeownerClient;
  session: Session;
  company: HomeownerCompany;
  windowId: string;
  onDone: (d: Draft) => void;
  onBack: () => void;
}) {
  const ar = useArSupport();
  // AR where the phone has it; the bank card everywhere (and as the person's own choice)
  const [chosen, setChosen] = useState<'ar' | 'card' | null>(null);
  const mode: 'ar' | 'card' | null = chosen ?? (ar === 'checking' ? null : ar === 'supported' ? 'ar' : 'card');
  return (
    <section className={q.card} data-screen="measure" data-method={mode ?? 'checking'}>
      <Title>{mode === 'ar' ? copy.arTitle : copy.measureTitle}</Title>
      {mode === 'ar' ? (
        <Suspense fallback={<p role="status">{copy.loading}</p>}>
          <LazyArMeasure
            photo={null}
            uploadPhoto={async (file) => {
              const up = await client.upload(session, file);
              return { id: up.id, widthPx: up.widthPx, heightPx: up.heightPx, focal35mm: null, takenAt: null };
            }}
            onResult={(r) =>
              onDone({
                id: windowId,
                scale: { kind: 'ar', pointsM: r.pointsM, trackingLostCount: r.trackingLostCount, device: 'webxr' },
                uploadId: r.upload.id,
                corners: r.corners,
              })
            }
          />
        </Suspense>
      ) : mode === 'card' ? (
        <CardCapture windowId={windowId} upload={(blob) => client.upload(session, blob)} maxPhotoBytes={company.limits.maxPhotoBytes} onDone={onDone} />
      ) : (
        <p role="status">{copy.loading}</p>
      )}
      {ar === 'supported' && mode !== null ? (
        <Button variant="ghost" className={q.secondary} onClick={() => setChosen(mode === 'ar' ? 'card' : 'ar')}>
          {mode === 'ar' ? copy.measureCardInstead : copy.measureArInstead}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={onBack}>
        {copy.back}
      </Button>
    </section>
  );
}

export function Describe({
  client,
  session,
  company,
  view,
  draft,
  onSaved,
  onRedo,
}: {
  client: HomeownerClient;
  session: Session;
  company: HomeownerCompany;
  view: HomeownerRequestView;
  draft: Draft;
  onSaved: (v: HomeownerRequestView) => void;
  onRedo: () => void;
}) {
  const choices = roomChoices(view.rooms);
  const [room, setRoom] = useState<string>(view.rooms[view.rooms.length - 1] ?? '');
  const [other, setOther] = useState('');
  const [label, setLabel] = useState('');
  const [style, setStyle] = useState<WindowStyle | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomError, setRoomError] = useState<string | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);
  const [redo, setRedo] = useState(false);
  const otherPicked = room === '';
  const chosenRoom = (otherPicked ? other : room).trim();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setRoomError(chosenRoom === '' ? copy.describeRoomRequired : null);
    setStyleError(style === '' ? copy.describeStyleRequired : null);
    if (chosenRoom === '' || style === '') return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await client.putWindow(session, windowInput(draft, chosenRoom, label, style)));
    } catch (err) {
      setError(messageOf(err));
      setRedo(err instanceof HomeownerApiError && (err.code === 'window_unsizable' || err.status === 400));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={q.card} data-screen="describe">
      <Title>{copy.describeTitle}</Title>
      <form className={q.leadForm} onSubmit={(e) => void submit(e)} noValidate>
        <fieldset className={styles.fieldset}>
          <legend className={q.legend}>{copy.describeRoom}</legend>
          <div className={styles.choices} role="radiogroup" aria-label={copy.describeRoom}>
            {choices.map((r) => (
              <label key={r} className={styles.choice} data-checked={room === r ? 'true' : undefined}>
                <input type="radio" name="room" checked={room === r} onChange={() => setRoom(r)} />
                <span>{r}</span>
              </label>
            ))}
            <label className={styles.choice} data-checked={otherPicked ? 'true' : undefined}>
              <input type="radio" name="room" checked={otherPicked} onChange={() => setRoom('')} />
              <span>{copy.describeOtherRoom}</span>
            </label>
          </div>
          {otherPicked ? (
            <Field label={copy.describeOtherRoom} labelHidden placeholder={copy.describeOtherPlaceholder} value={other} maxLength={ROOM_MAX} onChange={(e) => setOther(e.target.value)} autoComplete="off" />
          ) : null}
          {roomError !== null ? (
            <p className={q.error} role="alert">
              {roomError}
            </p>
          ) : null}
        </fieldset>
        <Field label={copy.describeLabel} placeholder={copy.describeLabelPlaceholder} value={label} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
        <fieldset className={styles.fieldset}>
          <legend className={q.legend}>{copy.describeStyle}</legend>
          <div className={styles.choices} role="radiogroup" aria-label={copy.describeStyle}>
            {company.windowStyles.map((s) => (
              <label key={s.key} className={styles.choice} data-checked={style === s.key ? 'true' : undefined}>
                <input type="radio" name="style" checked={style === s.key} onChange={() => setStyle(s.key)} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
          {styleError !== null ? (
            <p className={q.error} role="alert">
              {styleError}
            </p>
          ) : null}
        </fieldset>
        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        {redo ? (
          <Button variant="ghost" className={q.secondary} onClick={onRedo}>
            {copy.describeRedo}
          </Button>
        ) : null}
        <Button type="submit" size="lg" className={q.primary} busy={busy}>
          {copy.describeSave}
        </Button>
      </form>
    </section>
  );
}

function WindowRow({ w, onRemove, busy }: { w: HomeownerWindow; onRemove: () => void; busy: boolean }) {
  const name = copy.listWindowName(w.room, w.label);
  return (
    <li className={styles.windowRow} data-window={w.id} data-quality={w.quality}>
      <div className={styles.windowText}>
        <strong>{name}</strong>
        <span className={styles.size}>{copy.listSize(w.sizeLabel)}</span>
        <span className={q.small}>{w.uncertaintyLabel}</span>
        {w.quality === 'check' ? <span className={q.small}>{copy.listCheck}</span> : null}
      </div>
      <Button variant="ghost" busy={busy} aria-label={copy.listRemoveLabel(name)} onClick={onRemove}>
        {copy.listRemove}
      </Button>
    </li>
  );
}

export function WindowsList({
  client,
  session,
  view,
  onView,
  onMeasure,
  onQuote,
}: {
  client: HomeownerClient;
  session: Session;
  view: HomeownerRequestView;
  onView: (v: HomeownerRequestView) => void;
  onMeasure: () => void;
  onQuote: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState('');
  const [countError, setCountError] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const hint = view.quote?.missingHint;

  const remove = async (id: string) => {
    setRemoving(id);
    setError(null);
    try {
      onView(await client.deleteWindow(session, id));
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setRemoving(null);
    }
  };
  const saveCount = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 80) {
      setCountError(copy.listHowManyInvalid);
      return;
    }
    setCountError(null);
    setCounting(true);
    try {
      onView(await client.setCount(session, n));
      setCount('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setCounting(false);
    }
  };

  return (
    <section className={q.card} data-screen="windows">
      <Title>{copy.listTitle}</Title>
      {view.windows.length === 0 ? (
        <p className={q.text}>{copy.listEmpty}</p>
      ) : (
        <>
          <p className={q.small}>{copy.listMeasured(view.windows.length)}</p>
          <ul className={styles.list} data-windows="">
            {view.windows.map((w) => (
              <WindowRow key={w.id} w={w} busy={removing === w.id} onRemove={() => void remove(w.id)} />
            ))}
          </ul>
        </>
      )}
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {hint !== undefined ? (
        <div className={styles.missing} data-missing-hint="">
          <strong>{copy.listMissing}</strong>
          <p className={q.text}>{hint.text}</p>
        </div>
      ) : null}
      <Button size="lg" className={q.secondary} variant="ghost" onClick={onMeasure}>
        {copy.listMeasureAnother}
      </Button>
      <form className={styles.countForm} onSubmit={(e) => void saveCount(e)} noValidate>
        <Field label={copy.listHowMany} help={copy.listHowManyLabel} inputMode="numeric" value={count} error={countError ?? undefined} onChange={(e) => setCount(e.target.value)} autoComplete="off" />
        <Button type="submit" variant="ghost" busy={counting}>
          {copy.listHowManySave}
        </Button>
      </form>
      {view.windows.length > 0 ? (
        <Button size="lg" className={q.primary} onClick={onQuote}>
          {copy.listSeeQuote}
        </Button>
      ) : null}
    </section>
  );
}

export function QuoteScreen({ view, onContinue, onMore }: { view: HomeownerRequestView; onContinue: () => void; onMore: () => void }) {
  const quote = view.quote;
  const priced = quote !== null && quote.tiers.some((t) => t.total > 0);
  return (
    <section className={q.card} data-screen="quote">
      <Title>{copy.quoteTitle}</Title>
      {!priced || quote === null ? (
        <p className={q.text}>{copy.quoteNone}</p>
      ) : (
        <>
          <p className={q.text}>{copy.quoteIntro}</p>
          <ul className={styles.tiers} data-tiers="">
            {quote.tiers.map((t) => (
              <li key={t.key} className={styles.tier} data-tier={t.key}>
                <span className={styles.tierLabel}>{t.label}</span>
                <strong className={styles.tierName}>{t.name}</strong>
                <span className={q.small}>{t.description}</span>
                <span className={styles.tierTotal}>{copy.quoteTotal(money.format(t.total))}</span>
              </li>
            ))}
          </ul>
          <p className={q.small}>{copy.quoteMeasured(quote.measuredCount)}</p>
          {quote.estimatedCount > 0 ? <p className={q.small}>{copy.quoteEstimated(quote.estimatedCount)}</p> : null}
          <p className={q.small}>{copy.quoteFinal}</p>
        </>
      )}
      <Button size="lg" className={q.primary} onClick={onContinue}>
        {copy.quoteContinue}
      </Button>
      <Button variant="ghost" className={q.secondary} onClick={onMore}>
        {copy.quoteMeasureMore}
      </Button>
    </section>
  );
}

export function Contact({
  client,
  session,
  company,
  view,
  onFiled,
  onConsentChanged,
}: {
  client: HomeownerClient;
  session: Session;
  company: HomeownerCompany;
  view: HomeownerRequestView;
  onFiled: (v: HomeownerRequestView) => void;
  onConsentChanged: () => void;
}) {
  const [form, setForm] = useState<ContactForm>({ firstName: '', lastName: '', email: '', phone: '', zip: zipOf(view.request.home.address), consent: false });
  const [text, setText] = useState(false);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ContactForm>(k: K, v: ContactForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = checkContact(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    setError(null);
    try {
      onFiled(
        await client.contact(session, {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          zip: form.zip.trim(),
          contactConsent: true,
          textConsent: text,
          consentVersion: company.consent.version,
        }),
      );
    } catch (err) {
      if (err instanceof HomeownerApiError && err.code === 'consent_changed') {
        onConsentChanged();
        setForm((f) => ({ ...f, consent: false }));
        setText(false);
        setError(copy.consentChanged);
      } else {
        setError(err instanceof HomeownerApiError && err.code === 'contact_filed' ? copy.contactFiledOther : messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={q.card} data-screen="contact">
      <Title>{copy.contactTitle}</Title>
      <p className={q.text}>{copy.contactIntro}</p>
      <form className={q.leadForm} onSubmit={(e) => void submit(e)} noValidate>
        <div className={q.twoUp}>
          <Field label={copy.firstName} value={form.firstName} error={errors.firstName} autoComplete="given-name" onChange={(e) => set('firstName', e.target.value)} />
          <Field label={copy.lastName} value={form.lastName} error={errors.lastName} autoComplete="family-name" onChange={(e) => set('lastName', e.target.value)} />
        </div>
        <Field label={copy.email} type="email" inputMode="email" value={form.email} error={errors.email} autoComplete="email" onChange={(e) => set('email', e.target.value)} />
        <Field label={copy.phone} type="tel" inputMode="tel" value={form.phone} error={errors.phone} autoComplete="tel" onChange={(e) => set('phone', e.target.value)} />
        <Field label={copy.zip} inputMode="numeric" value={form.zip} error={errors.zip} autoComplete="postal-code" onChange={(e) => set('zip', e.target.value)} />
        <div className={q.consent}>
          <Checkbox checked={form.consent} onChange={(v) => set('consent', v)} label={company.consent.text} error={errors.consent} />
          <Checkbox checked={text} onChange={setText} label={company.consent.textingText} />
          <p className={q.policyLinks}>
            <a href={company.privacyUrl} target="_blank" rel="noopener noreferrer">
              {copy.privacy}
            </a>{' '}
            <a href={company.termsUrl} target="_blank" rel="noopener noreferrer">
              {copy.terms}
            </a>
          </p>
        </div>
        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        <Button type="submit" size="lg" className={q.primary} busy={busy}>
          {busy ? copy.sending : copy.send}
        </Button>
      </form>
    </section>
  );
}

export function Book({ client, session, company, onBooked }: { client: HomeownerClient; session: Session; company: HomeownerCompany; onBooked: (v: HomeownerRequestView) => void }) {
  const [slots, setSlots] = useState<HomeownerSlots | null>(company.booking ? null : { timeZone: 'UTC', slots: [] });
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const none: HomeownerSlots = { timeZone: 'UTC', slots: [] };
  const load = () =>
    client.slots(session).then(
      (s) => {
        setSlots(s);
        setPicked((p) => (s.slots.some((x) => x.start === p) ? p : ''));
      },
      () => setSlots(none),
    );
  useEffect(() => {
    // The times, once, when the screen opens (a company with booking off has none to ask for).
    if (!company.booking) return;
    let live = true;
    client.slots(session).then(
      (s) => live && setSlots(s),
      () => live && setSlots({ timeZone: 'UTC', slots: [] }),
    );
    return () => {
      live = false;
    };
  }, [client, session, company.booking]);

  const book = async (body: { slotStart: string } | { callMe: true }) => {
    setBusy(true);
    setError(null);
    try {
      onBooked(await client.book(session, body));
    } catch (err) {
      if (err instanceof HomeownerApiError && err.code === 'slot_taken') {
        setError(copy.bookTaken);
        await load();
      } else {
        setError(err instanceof HomeownerApiError ? err.message : copy.bookFailed);
      }
    } finally {
      setBusy(false);
    }
  };

  const open = slots?.slots ?? [];
  return (
    <section className={q.card} data-screen="book">
      <Title>{copy.bookTitle}</Title>
      <p className={q.text}>{copy.bookIntro}</p>
      {slots === null ? (
        <p role="status">{copy.loading}</p>
      ) : open.length === 0 ? (
        <p className={q.note}>{copy.bookNone}</p>
      ) : (
        <fieldset className={styles.fieldset}>
          <legend className={q.legend}>{copy.bookSlot}</legend>
          <div className={styles.choices} role="radiogroup" aria-label={copy.bookSlot}>
            {open.map((s) => (
              <label key={s.id} className={styles.choice} data-checked={picked === s.start ? 'true' : undefined}>
                <input type="radio" name="slot" checked={picked === s.start} onChange={() => setPicked(s.start)} />
                <span>{visitTime(s.start, slots.timeZone, 'long')}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      {open.length > 0 ? (
        <Button size="lg" className={q.primary} busy={busy} disabled={picked === ''} onClick={() => void book({ slotStart: picked })}>
          {copy.bookButton}
        </Button>
      ) : null}
      <Button size="lg" variant={open.length > 0 ? 'ghost' : 'primary'} className={open.length > 0 ? q.secondary : q.primary} busy={busy} onClick={() => void book({ callMe: true })}>
        {copy.bookCallMe}
      </Button>
    </section>
  );
}

export function Booked({ view, company, companyName, onMore }: { view: HomeownerRequestView; company: HomeownerCompany; companyName: string; onMore: () => void }) {
  const visit = view.booking?.visit ?? null;
  const rep = view.status?.rep?.name;
  return (
    <section className={q.card} data-screen="booked">
      <Title>{copy.bookedTitle}</Title>
      {visit !== null ? (
        <>
          <p className={q.note}>{copy.bookedVisit(visitTime(visit.start, visit.timeZone, 'long'))}</p>
          {rep !== undefined ? <p className={q.text}>{copy.bookedRep(rep)}</p> : null}
        </>
      ) : (
        <p className={q.note}>{copy.bookedCall(companyName)}</p>
      )}
      <p className={q.text}>{copy.bookedNext}</p>
      {company.phone !== null ? (
        <Button href={`tel:${company.phone}`} variant="ghost" className={q.secondary}>
          {`${copy.bookedCallUs} ${formatPhone(company.phone)}`}
        </Button>
      ) : null}
      <Button variant="ghost" onClick={onMore}>
        {copy.bookedAddMore}
      </Button>
    </section>
  );
}
