import { useEffect, useMemo, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router';
import { calculateQuote, isTimeZone, money, type Calculation, type Pricebook, type QuoteView, type Scope } from '@roofline/shared';
import { Banner, Button, EmptyState, Sheet, Skeleton, StatCard, UiLink } from '@roofline/ui';
import { quotes } from '../../copy/quotes.ts';
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

/** The day of an instant in the company's time zone, or null when the zone is not a real one. */
function dayIn(instant: string, timeZone: string | undefined): string | null {
  if (timeZone === undefined || !isTimeZone(timeZone)) return null;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone }).format(new Date(instant));
}

/** The quote screen inside a job: the stat strip, the actions, the editor, the lines and the totals. */
export function QuoteWindow() {
  const { quoteId = '' } = useParams();
  const quote = useQuote(quoteId);
  if (quote.isError) return <EmptyState title={quotes.loadFailed} />;
  if (quote.data === undefined) {
    return (
      <div>
        <p className={styles.loading}>{quotes.loading}</p>
        <Skeleton lines={4} />
      </div>
    );
  }
  return <QuoteBody key={quoteId} quote={quote.data} />;
}

/** The loaded quote. Remounted for each quote id, so the draft always starts from the quote on screen. */
function QuoteBody({ quote: loaded }: { quote: QuoteView }) {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
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

  const finalizedOn = quote.finalizedAt === null ? null : dayIn(quote.finalizedAt, company.data?.timezone);

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
    <div className={styles.window}>
      <section aria-label={quotes.statsLabel} className={styles.stats}>
        <StatCard label={quotes.statNumber} value={quote.number} />
        <StatCard label={quotes.statStatus} value={quotes.status[quote.status] ?? quote.status} />
        <StatCard
          label={quotes.statTotal}
          value={shown === null ? '' : money(shown.totalCents)}
          hint={quotes.estimateLabel}
        />
      </section>

      <div role="group" aria-label={quotes.actionsLabel} className={styles.actions}>
        {editable ? (
          <Button
            variant="ghost"
            disabled={!dirty || !inputsValid}
            busy={save.isPending}
            onClick={() => save.mutate(saveBodyOf(draft, quote))}
          >
            {quotes.save}
          </Button>
        ) : null}
        {editable ? (
          <Button disabled={!inputsValid} onClick={() => setSheetOpen(true)}>
            {quotes.markFinal}
          </Button>
        ) : null}
        {isFinal && quote.canEdit ? (
          <Button busy={copy.isPending} onClick={() => void copyQuote()}>
            {quotes.copy}
          </Button>
        ) : null}
        <UiLink href={quotePdfHref(quote.id)} download className={styles.pdf}>
          {quotes.downloadPdf}
        </UiLink>
      </div>

      {isFinal ? <p className={styles.note}>{quotes.readOnlyNote}</p> : null}
      {finalizedOn !== null ? <p className={styles.note}>{quotes.finalizedOn(finalizedOn)}</p> : null}
      {shown === null ? <Banner tone="danger">{quotes.fixInputs}</Banner> : null}

      <QuoteEditor draft={draft} readOnly={!editable} onChange={setDraft} onValidityChange={setInputsValid} />

      {shown !== null ? (
        <>
          <QuoteLines lines={shown.lines} />
          <QuoteTotals
            subtotalCents={shown.subtotalCents}
            markupCents={shown.markupCents}
            markupPercent={draft.scope.markupPercent}
            taxCents={shown.taxCents}
            totalCents={shown.totalCents}
          />
        </>
      ) : null}

      <Sheet
        open={sheetOpen}
        title={quotes.confirmFinalTitle}
        closeLabel={quotes.cancel}
        onClose={() => setSheetOpen(false)}
        footer={
          <div className={styles.sheetActions}>
            <Button variant="ghost" onClick={() => setSheetOpen(false)}>
              {quotes.cancel}
            </Button>
            <Button disabled={!inputsValid} busy={save.isPending || finalize.isPending} onClick={() => void confirmFinal()}>
              {quotes.confirmFinal}
            </Button>
          </div>
        }
      >
        <p>{quotes.confirmFinalBody}</p>
      </Sheet>
    </div>
  );
}
