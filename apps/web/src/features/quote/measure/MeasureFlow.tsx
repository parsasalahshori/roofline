import { Banner, Button, Field, Skeleton } from '@roofline/ui';
import type { HomeownerCompany, HomeownerRequestView, QuoteProduct } from '@roofline/shared';
import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import { OfferBanner } from '../../public/Catalog.tsx';
import { TrustLine } from './TrustLine.tsx';
import { HomeownerApiError, homeownerApi, type HomeownerClient, type Session } from './api.ts';
import { Book, Booked, Coaching, Contact, Describe, MeasureWindow, QuoteScreen, Rooms, Title, WindowsList } from './Screens.tsx';
import { flowReducer, newWindowId, startFlow, stepOf, type FlowState } from './flow.ts';
import { clearStored, readSeed, readStored, writeStored } from './session.ts';
import q from '../QuotePage.module.css';
import styles from './MeasureFlow.module.css';

/*
 * The measuring flow at /q/:slug/measure: it opens a homeowner request (or resumes the one in this browser), then walks
 * coaching -> rooms -> measure -> name it -> windows -> quote -> contact -> book -> booked. The server's view of the
 * request is the only record: windows, quote and booking all come back from it, so a reload loses nothing.
 */

type Boot =
  | { kind: 'loading' }
  | { kind: 'address'; error?: string }
  | { kind: 'creating' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; session: Session; view: HomeownerRequestView };

type Opened = { session: Session; view: HomeownerRequestView } | { needAddress: true } | { failed: string };

/** Resume the stored request when it is this estimate's, else open one from the quote's own address. */
export async function openRequest(slug: string, client: HomeownerClient, quoteId: string | null): Promise<Opened> {
  const stored = readStored(slug);
  if (stored !== null && (quoteId === null || stored.quoteId === quoteId)) {
    const session = { requestId: stored.requestId, token: stored.token };
    try {
      return { session, view: await client.view(session) };
    } catch (err) {
      if (!(err instanceof HomeownerApiError) || (err.status !== 401 && err.status !== 404)) return { failed: err instanceof HomeownerApiError ? err.message : copy.genericError };
      clearStored(slug);
    }
  }
  const seed = readSeed(slug);
  if (seed !== null && (quoteId === null || seed.quoteId === quoteId)) return createRequest(slug, client, seed.address, seed.services, seed.quoteId);
  return { needAddress: true };
}

export async function createRequest(slug: string, client: HomeownerClient, address: string, services: QuoteProduct[], quoteId: string | null): Promise<Opened> {
  try {
    const made = await client.create(address, services.includes('windows') ? services : [...services, 'windows']);
    const session = { requestId: made.requestId, token: made.token };
    writeStored(slug, { ...session, expiresAt: made.expiresAt, quoteId });
    return { session, view: await client.view(session) };
  } catch (err) {
    return { failed: err instanceof HomeownerApiError ? err.message : copy.genericError };
  }
}

export function MeasureFlow({ slug, quoteId }: { slug: string; quoteId: string | null }) {
  const client = useMemo(() => homeownerApi(slug), [slug]);
  const [company, setCompany] = useState<HomeownerCompany | null>(null);
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  // The opening (and the company) is started once per attempt, even when React runs the effect twice in development
  const opening = useRef<{ attempt: number; promise: Promise<[HomeownerCompany, Opened]> } | null>(null);

  useEffect(() => {
    let live = true;
    if (opening.current?.attempt !== attempt) {
      opening.current = {
        attempt,
        promise: client.company().then(async (c) => [c, await openRequest(slug, client, quoteId)] as [HomeownerCompany, Opened]),
      };
    }
    opening.current.promise.then(
      ([c, opened]) => {
        if (!live) return;
        setCompany(c);
        if ('session' in opened) setBoot({ kind: 'ready', ...opened });
        else if ('needAddress' in opened) setBoot({ kind: 'address' });
        else setBoot({ kind: 'failed', message: opened.failed });
      },
      (err: unknown) => {
        if (live) setBoot({ kind: 'failed', message: err instanceof HomeownerApiError && err.status === 404 ? copy.notFoundBody : err instanceof HomeownerApiError ? err.message : copy.loadFailed });
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, slug, quoteId]);

  const retry = () => {
    setBoot({ kind: 'loading' });
    setAttempt((a) => a + 1);
  };

  if (boot.kind === 'loading' || boot.kind === 'creating') {
    return (
      <div className={q.column} role="status">
        <span className="visually-hidden">{boot.kind === 'creating' ? copy.settingUp : copy.loading}</span>
        {boot.kind === 'creating' ? (
          <section className={q.card}>
            <h1 className={q.title}>{copy.settingUp}</h1>
            <p className={q.text}>{copy.settingUpSub}</p>
          </section>
        ) : (
          <Skeleton lines={3} />
        )}
      </div>
    );
  }
  if (boot.kind === 'failed' || company === null) {
    return (
      <div className={q.column}>
        <section className={q.card}>
          <h1 className={q.title}>{boot.kind === 'failed' ? boot.message : copy.loadFailed}</h1>
          <Button onClick={retry}>{copy.retry}</Button>
        </section>
      </div>
    );
  }
  if (boot.kind === 'address') {
    return (
      <div className={q.column}>
        <OfferBanner offer={company.catalog.offer} />
        <TrustLine trust={company.trust} />
        <AddressForm
          error={boot.error}
          onAddress={async (address) => {
            setBoot({ kind: 'creating' });
            const opened = await createRequest(slug, client, address, ['windows'], quoteId);
            if ('session' in opened) setBoot({ kind: 'ready', ...opened });
            else setBoot({ kind: 'address', error: 'failed' in opened ? opened.failed : copy.genericError });
          }}
        />
      </div>
    );
  }
  return <Journey client={client} session={boot.session} company={company} setCompany={setCompany} initial={boot.view} />;
}

function AddressForm({ error, onAddress }: { error?: string | undefined; onAddress: (address: string) => void }) {
  const [address, setAddress] = useState('');
  const [missing, setMissing] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (address.trim().length < 5) {
      setMissing(true);
      return;
    }
    onAddress(address.trim());
  };
  return (
    <section className={q.card} data-screen="address">
      <Title>{copy.addressTitle}</Title>
      <p className={q.text}>{copy.addressBody}</p>
      <form className={q.addressForm} onSubmit={submit} noValidate>
        <Field label={copy.addressLabel} placeholder={copy.addressPlaceholder} help={copy.addressHelp} value={address} error={missing ? copy.addressRequired : undefined} autoComplete="street-address" onChange={(e) => setAddress(e.target.value)} />
        {error !== undefined ? <Banner tone="danger">{error}</Banner> : null}
        <Button type="submit" size="lg" className={q.primary}>
          {copy.addressGo}
        </Button>
      </form>
    </section>
  );
}

function Progress({ step }: { step: number }) {
  return (
    <ol className={styles.progress} aria-label={copy.progressLabel} data-progress="">
      {copy.steps.map((s, i) => (
        <li key={s} data-state={i < step ? 'done' : i === step ? 'now' : 'next'} aria-current={i === step ? 'step' : undefined}>
          {s}
        </li>
      ))}
    </ol>
  );
}

function Journey({
  client,
  session,
  company,
  setCompany,
  initial,
}: {
  client: HomeownerClient;
  session: Session;
  company: HomeownerCompany;
  setCompany: (c: HomeownerCompany) => void;
  initial: HomeownerRequestView;
}) {
  const [state, dispatch] = useReducer(flowReducer, initial, startFlow);
  const [windowId, setWindowId] = useState(() => newWindowId());
  const view = state.view;

  const guard = (v: HomeownerRequestView) => {
    dispatch({ type: 'view', view: v });
  };
  const startWindow = () => {
    setWindowId(newWindowId());
    dispatch({ type: 'go', screen: 'measure' });
  };
  const go = (screen: FlowState['screen']) => dispatch({ type: 'go', screen });

  const screen = state.screen;
  return (
    <div className={q.column} data-flow-screen={screen}>
      <OfferBanner offer={company.catalog.offer} />
      <TrustLine trust={company.trust} />
      <Progress step={stepOf(screen)} />
      {screen === 'coaching' ? <Coaching view={view} onStart={() => go('rooms')} onContact={() => go('contact')} /> : null}
      {screen === 'rooms' ? <Rooms view={view} onMeasure={startWindow} onSeeWindows={() => go('windows')} /> : null}
      {screen === 'measure' ? (
        <MeasureWindow
          client={client}
          session={session}
          company={company}
          windowId={windowId}
          onDone={(draft) => dispatch({ type: 'measured', draft })}
          onBack={() => go(view.windows.length > 0 ? 'windows' : 'rooms')}
        />
      ) : null}
      {screen === 'describe' && state.draft !== null ? (
        <Describe client={client} session={session} company={company} view={view} draft={state.draft} onSaved={(v) => dispatch({ type: 'saved', view: v })} onRedo={() => dispatch({ type: 'discard' })} />
      ) : null}
      {screen === 'windows' ? <WindowsList client={client} session={session} view={view} onView={guard} onMeasure={startWindow} onQuote={() => go('quote')} /> : null}
      {screen === 'quote' ? <QuoteScreen company={company} view={view} onContinue={() => go(view.request.contactFiled ? (view.booking !== undefined ? 'booked' : 'book') : 'contact')} onMore={startWindow} /> : null}
      {screen === 'contact' ? (
        <Contact
          client={client}
          session={session}
          company={company}
          view={view}
          onFiled={(v) => {
            guard(v);
            go('book');
          }}
          onConsentChanged={() => void client.company().then(setCompany, () => undefined)}
        />
      ) : null}
      {screen === 'book' ? (
        <Book
          client={client}
          session={session}
          company={company}
          onBooked={(v) => {
            guard(v);
            go('booked');
          }}
        />
      ) : null}
      {screen === 'booked' ? <Booked view={view} company={company} companyName={company.name} onMore={startWindow} /> : null}
    </div>
  );
}
