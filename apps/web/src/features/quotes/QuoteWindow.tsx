import { useEffect, useMemo, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router';
import { calculateQuote, isTimeZone, money, type Calculation, type Pricebook, type QuoteView, type Scope } from '@roofline/shared';
import { Banner, Button, Icon, KpiTile, Panel, Sheet, Skeleton } from '@roofline/ui';
import { ApiError } from '../../api/client.ts';
import { quotes } from '../../copy/quotes.ts';
import { WINDOW_COPY } from '../../copy/rail.ts';
import { useIsPhone } from '../../shell/useIsPhone.ts';
import { DetailPage } from '../jobs/DetailPage.tsx';
import { EmptyPanel, LoadError } from '../jobs/states.tsx';
import { useJobView } from '../job/api.ts';
import { useCompany } from '../settings/api.ts';
import { quotePdfHref, useCopyQuote, useFinalizeQuote, useQuote, useSaveQuote } from './api.ts';
import type { QuoteDraft, SaveQuoteBody } from './draft.ts';
import { QuoteEditor } from './QuoteEditor.tsx';
import { QuoteLines } from './QuoteLines.tsx';
import { QuoteTotals } from './QuoteTotals.tsx';
import styles from './QuoteWindow.module.css';

/** The editable part of a quote, as the editor and the save body see it. */
const draftOf = (quote: QuoteView): QuoteDraft => ({ scope: quote.scope, notes: quote.notes ?? '' });

/** True when the draft has changes the quote does not have yet. */
const isDirty = (draft: QuoteDraft, quote: QuoteView): boolean => JSON.stringify(draft) !== JSON.stringify(draftOf(quote));

/** The whole-scope PATCH body: the measurement repeats area, type and pitch; empty notes are sent as null. */
function saveBodyOf(draft: QuoteDraft, quote: QuoteView): SaveQuoteBody {
  const notes = draft.notes.trim();
  return {
    measurement: {
      source: 'manual',
      areaSqFt: draft.scope.areaSqFt,
      areaType: draft.scope.areaType,
      pitch: draft.scope.pitch,
      notes: quote.measurement.notes,
    },
    scope: draft.scope,
    notes: notes === '' ? null : notes,
  };
}

/** The calculation on the frozen price snapshot, or null when the inputs cannot be priced. */
function tryCalculate(scope: Scope, prices: Pricebook): Calculation | null {
  try {
    return calculateQuote(scope, prices);
  } catch {
    return null;
  }
}

/** The day of an instant in the company's time zone, or null when the zone is not a real one. Short is "Nov 11", else "Nov 11, 2026". */
function dayIn(instant: string, timeZone: string | undefined, short = false): string | null {
  if (timeZone === undefined || !isTimeZone(timeZone)) return null;
  const options: Intl.DateTimeFormatOptions = short ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone }).format(new Date(instant));
}

const JOBS_CRUMB = { label: WINDOW_COPY.jobs.title, href: '/jobs' } as const;

/** The quote's place in the trail: Jobs, then the job it is on (named for its customer once that is known), then the quote. */
function useCrumbs(last: string) {
  const { jobId = '' } = useParams();
  const job = useJobView(jobId);
  return [JOBS_CRUMB, { label: job.data?.customer.displayName ?? quotes.crumbJob, href: `/jobs/${jobId}` }, { label: last }];
}

/** The panels' shape while the quote loads: the details at the left, the price lines at the right. */
function QuoteSkeleton() {
  return (
    <div role="status" aria-label={quotes.loading} aria-busy="true" className={styles.grid}>
      <div className={styles.main}>
        {[0, 1].map((panel) => (
          <div key={panel} className={styles.skeletonPanel}>
            <Skeleton lines={3} height="40px" />
          </div>
        ))}
      </div>
      <div className={styles.side}>
        <div className={styles.skeletonPanel}>
          <Skeleton lines={6} />
        </div>
      </div>
    </div>
  );
}

/** The quote screen inside a job: the head, the details to edit, and the price lines with the total beside them. */
export function QuoteWindow() {
  const { quoteId = '' } = useParams();
  const query = useQuote(quoteId);
  const crumbs = useCrumbs(quotes.pageTitle);

  if (query.data !== undefined) return <QuoteBody key={quoteId} quote={query.data} />;
  return (
    <DetailPage app="jobs" title={quotes.pageTitle} crumbs={crumbs}>
      {query.error instanceof ApiError && query.error.status === 404 ? (
        <EmptyPanel
          title={quotes.notFound}
          ghost="none"
          action={
            <Button variant="default" href="/jobs">
              {quotes.backToJobs}
            </Button>
          }
        />
      ) : query.isError ? (
        <LoadError tag={quotes.errorTag} title={quotes.loadFailed} retry={quotes.retry} busy={query.isFetching} onRetry={() => void query.refetch()} />
      ) : (
        <QuoteSkeleton />
      )}
    </DetailPage>
  );
}

/** The loaded quote. Remounted for each quote id, so the draft always starts from the quote on screen. */
function QuoteBody({ quote: loaded }: { quote: QuoteView }) {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const phone = useIsPhone();
  const company = useCompany();
  const save = useSaveQuote(loaded.id);
  const finalize = useFinalizeQuote(loaded.id);
  const copy = useCopyQuote(loaded.id);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [inputsValid, setInputsValid] = useState(true);

  // The last version the draft was built from. A new server version replaces the draft, unless the
  // person has edits the server does not have (then those edits stay, and only the baseline moves).
  const [base, setBase] = useState<QuoteView>(loaded);
  const [draft, setDraft] = useState<QuoteDraft>(() => draftOf(loaded));
  if (loaded !== base) {
    setBase(loaded);
    if (!isDirty(draft, base)) setDraft(draftOf(loaded));
  }
  const quote = loaded;
  const dirty = isDirty(draft, base);

  const isFinal = quote.status === 'final';
  const editable = !isFinal && quote.canEdit;

  // Priced from the quote's frozen snapshot, never the live pricebook; invalid inputs keep the last good result
  const computed = useMemo(() => tryCalculate(draft.scope, quote.prices), [draft.scope, quote.prices]);
  const [lastGood, setLastGood] = useState<Calculation | null>(computed);
  if (computed !== null && computed !== lastGood) setLastGood(computed);
  const shown = computed ?? lastGood;

  // Unsaved changes: a page close asks first, and so does moving to another screen in the app
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const blocker = useBlocker(dirty);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(quotes.unsavedWarning)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  const zone = company.data?.timezone;
  const finalizedOn = quote.finalizedAt === null ? null : dayIn(quote.finalizedAt, zone);
  const validUntil = dayIn(quote.validUntil, zone, true);
  const madeOn = dayIn(quote.createdAt, zone);
  const crumbs = useCrumbs(quote.number);

  const confirmFinal = async () => {
    if (!inputsValid) return;
    try {
      if (dirty) await save.mutateAsync(saveBodyOf(draft, quote));
      await finalize.mutateAsync();
      setSheetOpen(false);
    } catch {
      // The save or finalize hook has already said why; the sheet stays open for another try
    }
  };

  const copyQuote = async () => {
    try {
      const copied = await copy.mutateAsync();
      navigate(`/jobs/${jobId}/quotes/${copied.id}`);
    } catch {
      // The copy hook has already said why
    }
  };

  return (
    <DetailPage
      app="jobs"
      title={quotes.title(quote.number)}
      crumbs={crumbs}
      actions={
        <div role="group" aria-label={quotes.actionsLabel} className={styles.actions}>
          <Button href={quotePdfHref(quote.id)} variant="default" {...{ download: true }}>
            <Icon name="doc" size={16} />
            {quotes.downloadPdf}
          </Button>
          {editable ? (
            <Button variant="default" disabled={!dirty || !inputsValid} busy={save.isPending} onClick={() => save.mutate(saveBodyOf(draft, quote))}>
              {quotes.save}
            </Button>
          ) : null}
          {editable ? (
            <Button variant="primary" disabled={!inputsValid} onClick={() => setSheetOpen(true)}>
              <Icon name="check" size={16} />
              {quotes.markFinal}
            </Button>
          ) : null}
          {isFinal && quote.canEdit ? (
            <Button variant="primary" busy={copy.isPending} onClick={() => void copyQuote()}>
              {quotes.copy}
            </Button>
          ) : null}
        </div>
      }
      stats={
        <section aria-label={quotes.statsLabel} className={styles.stats}>
          <KpiTile
            label={quotes.statStatus}
            value={quotes.status[quote.status] ?? quote.status}
            meta={isFinal ? (finalizedOn !== null ? quotes.finalizedOn(finalizedOn) : undefined) : quotes.notFinal}
          />
          {/* A phone has the total pinned at the foot of the screen, so the strip keeps to the other two */}
          {!phone && shown !== null ? <KpiTile label={quotes.statTotal} value={money(shown.totalCents)} meta={quotes.estimateLabel} /> : null}
          {validUntil !== null ? <KpiTile label={quotes.statValid} value={validUntil} meta={madeOn !== null ? quotes.madeOn(madeOn) : undefined} /> : null}
        </section>
      }
    >
      {isFinal ? <p className={styles.note}>{quotes.readOnlyNote}</p> : null}
      {shown === null ? <Banner tone="danger">{quotes.fixInputs}</Banner> : null}

      <div className={styles.grid}>
        <div className={styles.main}>
          <QuoteEditor draft={draft} readOnly={!editable} onChange={setDraft} onValidityChange={setInputsValid} />
        </div>
        <div className={styles.side}>
          {shown !== null ? (
            <Panel title={quotes.priceLinesHeading} padded={false} className={styles.lines}>
              <QuoteLines lines={shown.lines} />
              <QuoteTotals
                subtotalCents={shown.subtotalCents}
                markupCents={shown.markupCents}
                markupPercent={draft.scope.markupPercent}
                taxCents={shown.taxCents}
                totalCents={shown.totalCents}
              />
            </Panel>
          ) : null}
        </div>
      </div>

      {/* A phone keeps the price in view while the numbers above it are edited */}
      {phone && shown !== null ? (
        <div className={styles.pinned} aria-hidden="true">
          <span className={styles.pinnedLabel}>{quotes.statTotal}</span>
          <span className={styles.pinnedTotal}>{money(shown.totalCents)}</span>
          <span className={styles.pinnedHint}>{quotes.estimateLabel}</span>
        </div>
      ) : null}

      <Sheet
        open={sheetOpen}
        title={quotes.confirmFinalTitle}
        closeLabel={quotes.cancel}
        onClose={() => setSheetOpen(false)}
        footer={
          <div className={styles.sheetActions}>
            <Button variant="quiet" onClick={() => setSheetOpen(false)}>
              {quotes.cancel}
            </Button>
            <Button variant="primary" disabled={!inputsValid} busy={save.isPending || finalize.isPending} onClick={() => void confirmFinal()}>
              {quotes.confirmFinal}
            </Button>
          </div>
        }
      >
        <p>{quotes.confirmFinalBody}</p>
      </Sheet>
    </DetailPage>
  );
}
