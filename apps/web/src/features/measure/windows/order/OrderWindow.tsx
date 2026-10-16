import { Banner, Button, Checkbox, EmptyState, Field, Skeleton } from '@roofline/ui';
import { deriveOrder, MAX_PO_LENGTH, type WindowOrderLinePatch, type WindowOrderPatch, type WindowOrderStatus, type WindowOrderView } from '@roofline/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../../../api/client.ts';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import frame from '../../MeasureWindow.module.css';
import { sheetCsvHref, sheetPdfHref, useCreateWindowOrder, useMarkReady, useMeasurementOrder, usePatchWindowOrder, useReopen } from './api.ts';
import { OrderLine, type LineEdit } from './OrderLine.tsx';
import { BulkBar, OrderSummary, type BulkChange } from './OrderSummary.tsx';
import styles from './OrderWindow.module.css';

export { OrderStatusChip } from './OrderChip.tsx';

/** Edits wait this long after the last change, then one PATCH carries them all. */
export const ORDER_SAVE_DEBOUNCE_MS = 400;

// A plain download link (same origin, cookie auth): Button passes the download attribute through to the anchor.
const DOWNLOAD = { download: true };
const windowsHref = (measurementId: string) => `/estimator/windows/${encodeURIComponent(measurementId)}`;
const messageOf = (error: unknown): string => (error instanceof ApiError && error.message !== '' ? error.message : copy.actionFailed);

type Draft = { lines: WindowOrderView['lines']; poNumber: string };
type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'error';
type Pending = { poNumber?: string; lines: Map<string, WindowOrderLinePatch> };

const draftOf = (v: WindowOrderView): Draft => ({ lines: v.lines, poNumber: v.poNumber });
const emptyPending = (): Pending => ({ lines: new Map() });
const isEmpty = (p: Pending) => p.poNumber === undefined && p.lines.size === 0;

/** The order's status as a chip: a word, never colour alone. */
export function OrderStatusPill({ status }: { status: WindowOrderStatus }) {
  return (
    <span className={styles.statusPill} data-status={status}>
      <span className="visually-hidden">{copy.statusLabel}</span>
      {copy.status[status]}
    </span>
  );
}

function Editor({ view, onResync }: { view: WindowOrderView; onResync: () => void }) {
  const locked = view.status !== 'draft';
  const patch = usePatchWindowOrder(view.id);
  const ready = useMarkReady(view.id);
  const reopen = useReopen(view.id);
  const refresh = useCreateWindowOrder(view.windowMeasurementId);

  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  // A new view from the server (marked ready, reopened, refreshed, or reloaded after a failed save) replaces what is
  // shown, unless the person has changes on the way: those win, and the next save brings the server in step.
  const [seen, setSeen] = useState(view);
  if (seen !== view) {
    setSeen(view);
    if (save !== 'waiting' && save !== 'saving') setDraft(draftOf(view));
  }

  // Saves: each change goes into `pending`; ORDER_SAVE_DEBOUNCE_MS after the last one, one PATCH carries them all
  const pending = useRef<Pending>(emptyPending());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutateRef = useRef(patch.mutateAsync);
  const resyncRef = useRef(onResync);
  useEffect(() => {
    mutateRef.current = patch.mutateAsync;
    resyncRef.current = onResync;
  });
  const flush = useCallback((): Promise<void> => {
    clearTimeout(timer.current);
    const p = pending.current;
    if (isEmpty(p)) return Promise.resolve();
    pending.current = emptyPending();
    const body: WindowOrderPatch = {
      ...(p.poNumber !== undefined && { poNumber: p.poNumber }),
      ...(p.lines.size > 0 && { lines: [...p.lines.values()] }),
    };
    setSave('saving');
    return mutateRef.current(body).then(
      (result) => {
        if (isEmpty(pending.current)) {
          setDraft(draftOf(result));
          setSave('saved');
        }
      },
      (error: unknown) => {
        setSaveError(messageOf(error));
        setSave('error');
        resyncRef.current();
      },
    );
  }, []);
  useEffect(
    () => () => {
      void flush();
    },
    [flush],
  );
  const later = () => {
    clearTimeout(timer.current);
    setSave('waiting');
    timer.current = setTimeout(() => void flush(), ORDER_SAVE_DEBOUNCE_MS);
  };
  const queueLine = (id: string, edit: LineEdit) => {
    const before = pending.current.lines.get(id) ?? { id };
    pending.current.lines.set(id, { ...before, ...edit });
  };

  const editLine = (id: string, edit: LineEdit, localOnly = false) => {
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.id === id ? { ...l, ...edit } : l)) }));
    if (localOnly) return;
    queueLine(id, edit);
    later();
  };
  const editPo = (poNumber: string) => {
    setDraft((d) => ({ ...d, poNumber }));
    pending.current.poNumber = poNumber;
    later();
  };
  const applyBulk = (change: BulkChange) => {
    const edits = new Map<string, LineEdit>();
    for (const line of draft.lines) {
      if (!selected.has(line.id)) continue;
      const { gridType, ...rest } = change;
      edits.set(line.id, { ...rest, ...(gridType !== undefined && { grid: { ...line.grid, type: gridType } }) });
    }
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (edits.has(l.id) ? { ...l, ...edits.get(l.id) } : l)) }));
    for (const [id, edit] of edits) queueLine(id, edit);
    void flush();
  };

  const derived = useMemo(() => deriveOrder(draft.lines, view.settings), [draft.lines, view.settings]);
  const attention = derived.checked.filter((c) => !c.orderable).length;
  const canMark = view.status === 'draft' && view.mayMarkReady && derived.canMarkReady;
  const allSelected = draft.lines.length > 0 && draft.lines.every((l) => selected.has(l.id));
  const toggle = (id: string, next: boolean) =>
    setSelected((s) => {
      const out = new Set(s);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });

  const markReady = () => {
    void flush().then(() => ready.mutate());
  };
  const bringIn = () => {
    void flush().then(() => refresh.mutate());
  };
  const actionError = ready.error ?? reopen.error ?? refresh.error;

  return (
    <div className={styles.scroll}>
      <div className={styles.content}>
        <section className={styles.top} aria-labelledby="order-address">
          <div className={styles.topLine}>
            <h3 id="order-address" className={styles.address}>
              {view.address}
            </h3>
            <OrderStatusPill status={view.status} />
            <p className={styles.saveState} aria-live="polite" data-save={save}>
              {save === 'saving' || save === 'waiting' ? copy.saving : save === 'saved' ? copy.saved : save === 'error' ? copy.saveFailed(saveError) : null}
            </p>
          </div>
          <div className={styles.topLine}>
            {locked ? (
              view.poNumber !== '' ? (
                <span className={styles.po}>{copy.poShown(view.poNumber)}</span>
              ) : null
            ) : (
              <Field
                className={styles.poField}
                label={copy.poLabel}
                placeholder={copy.poPlaceholder}
                value={draft.poNumber}
                maxLength={MAX_PO_LENGTH}
                onChange={(e) => editPo(e.currentTarget.value)}
              />
            )}
            {!locked ? (
              <Button variant="ghost" className={styles.tall} busy={refresh.isPending} onClick={bringIn}>
                {refresh.isPending ? copy.refreshing : copy.refresh}
              </Button>
            ) : null}
          </div>
          <Banner tone="info">{copy.onlyPhotoNote}</Banner>
        </section>

        {!locked && selected.size > 0 ? <BulkBar count={selected.size} onApply={applyBulk} onClear={() => setSelected(new Set())} /> : null}

        {draft.lines.length === 0 ? (
          <EmptyState title={copy.noLines} />
        ) : (
          <>
            {!locked ? (
              <div className={styles.selectAll}>
                <Checkbox
                  checked={allSelected}
                  label={copy.selectAll}
                  onChange={(next) => setSelected(next ? new Set(draft.lines.map((l) => l.id)) : new Set())}
                />
              </div>
            ) : null}
            <table className={styles.lines}>
              <caption className={styles.caption}>{copy.tableCaption}</caption>
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">{copy.columns.select}</span>
                  </th>
                  <th scope="col">{copy.columns.photo}</th>
                  <th scope="col">{copy.columns.location}</th>
                  <th scope="col">{copy.columns.measured}</th>
                  <th scope="col">
                    <span title={copy.orderHint}>{copy.columns.order}</span>
                  </th>
                  <th scope="col">{copy.columns.quantity}</th>
                  <th scope="col">{copy.columns.status}</th>
                </tr>
              </thead>
              {draft.lines.map((line, i) => (
                <OrderLine
                  key={line.id}
                  line={line}
                  checked={derived.checked[i]!}
                  n={i + 1}
                  measurementId={view.windowMeasurementId}
                  locked={locked}
                  selected={selected.has(line.id)}
                  onSelect={(next) => toggle(line.id, next)}
                  onEdit={(edit, localOnly) => editLine(line.id, edit, localOnly)}
                />
              ))}
            </table>
          </>
        )}

        <div className={styles.bottom}>
          <OrderSummary totals={derived.totals} groups={derived.groups} />
          <section className={styles.panel} aria-labelledby="order-actions-title">
            <h3 id="order-actions-title" className={styles.panelTitle}>
              {copy.actionsTitle}
            </h3>
            {view.status === 'draft' ? (
              <>
                <Button className={styles.tall} disabled={!canMark} busy={ready.isPending} onClick={markReady}>
                  {ready.isPending ? copy.markingReady : copy.markReady}
                </Button>
                {!view.mayMarkReady ? <p className={styles.muted}>{copy.ownerMarksReady}</p> : null}
                {draft.lines.length > 0 && attention > 0 ? <p className={styles.muted}>{copy.linesNeedAttention(attention)}</p> : null}
              </>
            ) : view.status === 'ready' ? (
              <>
                <p className={styles.muted}>{copy.readyLocked}</p>
                {view.mayMarkReady ? (
                  <Button variant="ghost" className={styles.tall} busy={reopen.isPending} onClick={() => reopen.mutate()}>
                    {reopen.isPending ? copy.reopening : copy.reopen}
                  </Button>
                ) : null}
              </>
            ) : (
              <p className={styles.muted}>{copy.sentLocked}</p>
            )}
            {actionError ? <Banner tone="danger">{messageOf(actionError)}</Banner> : null}
            <div className={styles.downloads}>
              {view.status !== 'draft' ? (
                <Button className={styles.tall} href={sheetCsvHref(view.id)} {...DOWNLOAD}>
                  {copy.downloadCsv}
                </Button>
              ) : null}
              <Button variant="ghost" className={styles.tall} href={sheetPdfHref(view.id)} {...DOWNLOAD}>
                {view.status === 'draft' ? copy.draftPdf : copy.downloadPdf}
              </Button>
            </div>
            <p className={styles.muted}>{copy.sendNote}</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Opens the measurement's order, making it from the photo windows the first time. */
function OrderBody({ measurementId }: { measurementId: string }) {
  const query = useMeasurementOrder(measurementId);
  const create = useCreateWindowOrder(measurementId);
  const createRef = useRef(create.mutate);
  useEffect(() => {
    createRef.current = create.mutate;
  });
  const none = query.data === null;
  const asked = useRef(false);
  useEffect(() => {
    if (none && !asked.current) {
      asked.current = true;
      createRef.current();
    }
  }, [none]);

  const back = (
    <Button variant="ghost" className={styles.tall} href={windowsHref(measurementId)}>
      {copy.back}
    </Button>
  );

  if (query.data) return <Editor key={query.data.id} view={query.data} onResync={() => void query.refetch()} />;
  if (create.isError) {
    if (create.error instanceof ApiError && create.error.status === 422) {
      return (
        <div className={styles.centre}>
          <EmptyState title={copy.noPhotoWindowsTitle} body={create.error.message !== '' ? create.error.message : copy.noPhotoWindowsBody} action={back} />
        </div>
      );
    }
    return (
      <div className={styles.centre}>
        <EmptyState
          title={copy.loadFailed}
          body={messageOf(create.error)}
          action={
            <Button className={styles.tall} onClick={() => create.mutate()}>
              {copy.tryAgain}
            </Button>
          }
        />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className={styles.centre}>
        <EmptyState title={copy.loadFailed} body={messageOf(query.error)} action={back} />
      </div>
    );
  }
  return (
    <div className={styles.centre} role="status">
      <p className={styles.preparing}>{none ? copy.preparing : copy.loading}</p>
      {none ? <p className={styles.muted}>{copy.preparingBody}</p> : null}
      <Skeleton lines={4} height="1.25rem" width="min(480px, 90%)" />
    </div>
  );
}

/** The factory order for a window measurement: /estimator/windows/:windowMeasurementId/order. */
export function OrderWindow() {
  const { windowMeasurementId = '' } = useParams();
  return (
    <div className={frame.window} data-window-order="">
      <header className={frame.header}>
        <span className={frame.appIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path d="M4 3h16v18H4zM4 12h16M12 3v18" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className={frame.heading}>{copy.title}</h2>
        <span className={frame.subtitle}>{copy.subtitle}</span>
        <span className={styles.headerBack}>
          <Button variant="ghost" className={styles.tall} href={windowsHref(windowMeasurementId)}>
            {copy.back}
          </Button>
        </span>
      </header>
      <OrderBody key={windowMeasurementId} measurementId={windowMeasurementId} />
    </div>
  );
}
