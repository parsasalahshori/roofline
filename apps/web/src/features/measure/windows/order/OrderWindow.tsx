import { Banner, Button, EmptyState, Icon, Panel, Skeleton } from '@roofline/ui';
import { deriveOrder, type OrderLineStatus, type WindowOrderLinePatch, type WindowOrderPatch, type WindowOrderView } from '@roofline/shared';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import { ApiError } from '../../../../api/client.ts';
import { windowOrder as copy } from '../../../../copy/windowOrder.ts';
import { MeasurePage } from '../../MeasurePage.tsx';
import { useCreateWindowOrder, useMarkReady, useMeasurementOrder, usePatchWindowOrder, useReopen } from './api.ts';
import { LineDetail, type LineEdit } from './OrderLine.tsx';
import { OrderSheet } from './OrderSheet.tsx';
import { BulkBar, OrderSummary, type BulkChange } from './OrderSummary.tsx';
import { orderRule, OrderStatusPill, OrderTicket } from './OrderTicket.tsx';
import styles from './OrderWindow.module.css';

export { OrderStatusChip } from './OrderChip.tsx';
export { OrderStatusPill };

/** Edits wait this long after the last change, then one PATCH carries them all. */
export const ORDER_SAVE_DEBOUNCE_MS = 400;

const windowsHref = (measurementId: string) => `/estimator/windows/${encodeURIComponent(measurementId)}`;
const messageOf = (error: unknown): string => (error instanceof ApiError && error.message !== '' ? error.message : copy.actionFailed);

type Draft = { lines: WindowOrderView['lines']; poNumber: string };
type SaveState = 'idle' | 'waiting' | 'saving' | 'saved' | 'error';
type Pending = { poNumber?: string; lines: Map<string, WindowOrderLinePatch> };

const draftOf = (v: WindowOrderView): Draft => ({ lines: v.lines, poNumber: v.poNumber });
const emptyPending = (): Pending => ({ lines: new Map() });
const isEmpty = (p: Pending) => p.poNumber === undefined && p.lines.size === 0;

/** The page every state of the order sits in: the trail "Factory orders > street" and, when there is one, the save state. */
function OrderFrame({ address, titleHidden = false, barExtra, children }: { address: string | null; titleHidden?: boolean; barExtra?: ReactNode; children: ReactNode }) {
  return (
    <MeasurePage section="order" address={address} title={copy.title} subtitle={copy.subtitle} titleHidden={titleHidden} barExtra={barExtra} layout="flow">
      {children}
    </MeasurePage>
  );
}

/** "All changes saved" at the top right, as the work goes: saving, saved, or what went wrong. A locked order has nothing to save. */
function SaveStateText({ save, error, locked }: { save: SaveState; error: string; locked: boolean }) {
  const busy = save === 'saving' || save === 'waiting';
  return (
    <p className={styles.saveState} aria-live="polite" data-save={save === 'idle' ? 'saved' : save}>
      {locked ? null : (
        <>
          <Icon name={save === 'error' ? 'alert' : busy ? 'clock' : 'check'} size={16} />
          {busy ? copy.saving : save === 'error' ? copy.saveFailed(error) : copy.saved}
        </>
      )}
    </p>
  );
}

const tally = (checked: readonly { status: OrderLineStatus }[]) => ({
  ready: checked.filter((c) => c.status === 'ready').length,
  check: checked.filter((c) => c.status === 'check').length,
  hold: checked.filter((c) => c.status === 'error').length,
});

function Editor({ view, onResync }: { view: WindowOrderView; onResync: () => void }) {
  const locked = view.status !== 'draft';
  const patch = usePatchWindowOrder(view.id);
  const ready = useMarkReady(view.id);
  const reopen = useReopen(view.id);
  const refresh = useCreateWindowOrder(view.windowMeasurementId);
  const reasonId = useId();

  const [draft, setDraft] = useState<Draft>(() => draftOf(view));
  const [save, setSave] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  // The window in the panel beside the table starts as the first that needs a look (else the first) and stays until
  // another is picked, however the edits change what needs a look
  const [picked, setPicked] = useState<string | null>(() => {
    const first = view.checked.findIndex((c) => c.status !== 'ready');
    return view.lines[first >= 0 ? first : 0]?.id ?? null;
  });

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
      if (!ticked.has(line.id)) continue;
      const { gridType, ...rest } = change;
      edits.set(line.id, { ...rest, ...(gridType !== undefined && { grid: { ...line.grid, type: gridType } }) });
    }
    setDraft((d) => ({ ...d, lines: d.lines.map((l) => (edits.has(l.id) ? { ...l, ...edits.get(l.id) } : l)) }));
    for (const [id, edit] of edits) queueLine(id, edit);
    void flush();
  };

  const derived = useMemo(() => deriveOrder(draft.lines, view.settings), [draft.lines, view.settings]);
  const counts = tally(derived.checked);
  const attention = derived.checked.filter((c) => !c.orderable).length;
  const canMark = view.status === 'draft' && view.mayMarkReady && derived.canMarkReady;
  const tick = (id: string, next: boolean) =>
    setTicked((s) => {
      const out = new Set(s);
      if (next) out.add(id);
      else out.delete(id);
      return out;
    });

  // A window that went away (new photo windows brought in) gives way to the first
  const pickedId = picked !== null && draft.lines.some((l) => l.id === picked) ? picked : (draft.lines[0]?.id ?? null);
  const pickedAt = draft.lines.findIndex((l) => l.id === pickedId);

  const markReady = () => {
    void flush().then(() => ready.mutate());
  };
  const bringIn = () => {
    void flush().then(() => refresh.mutate());
  };
  const actionError = ready.error ?? reopen.error ?? refresh.error;
  const rule = orderRule(view.settings);

  const foot = (
    <div className={styles.foot}>
      <div className={styles.footText}>
        {draft.lines.length > 0 ? (
          <p className={styles.counts} data-counts="">
            {counts.ready > 0 ? <span data-count="ready">{copy.counts.ready(counts.ready)}</span> : null}
            {counts.check > 0 ? <span data-count="check">{copy.counts.check(counts.check)}</span> : null}
            {counts.hold > 0 ? <span data-count="hold">{copy.counts.hold(counts.hold)}</span> : null}
          </p>
        ) : null}
        <div id={reasonId} className={styles.footReasons}>
          {view.status === 'draft' ? (
            <>
              {!view.mayMarkReady ? <p className={styles.reason}>{copy.ownerMarksReady}</p> : null}
              {draft.lines.length > 0 && attention > 0 ? (
                <p className={styles.reason} data-tone={counts.hold > 0 ? 'stop' : 'look'}>
                  <Icon name="alert" size={16} />
                  {copy.linesNeedAttention(attention)}
                </p>
              ) : null}
              <p className={styles.note}>{copy.sendNote}</p>
            </>
          ) : view.status === 'ready' ? (
            <p className={styles.note}>{copy.readyLocked}</p>
          ) : (
            <p className={styles.note}>{copy.sentLocked}</p>
          )}
        </div>
      </div>
      <div className={styles.footActions}>
        {view.status === 'draft' ? (
          <>
            <Button variant="default" onClick={() => void flush()}>
              {copy.saveDraft}
            </Button>
            <Button disabled={!canMark} busy={ready.isPending} aria-describedby={reasonId} onClick={markReady}>
              {ready.isPending ? copy.markingReady : copy.markReady}
            </Button>
          </>
        ) : view.status === 'ready' && view.mayMarkReady ? (
          <Button variant="default" busy={reopen.isPending} onClick={() => reopen.mutate()}>
            {reopen.isPending ? copy.reopening : copy.reopen}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <OrderFrame address={view.address} titleHidden barExtra={<SaveStateText save={save} error={saveError} locked={locked} />}>
      <div className={styles.host} data-window-order="">
        <OrderTicket
          id={view.id}
          address={view.address}
          status={view.status}
          poNumber={draft.poNumber}
          lineCount={draft.lines.length}
          locked={locked}
          onPo={editPo}
          windowsHref={windowsHref(view.windowMeasurementId)}
        />
        <div className={styles.rule}>
          <Icon name="ruler" size={16} />
          <div>
            <p>{rule}</p>
            <p>{copy.onlyPhotoNote}</p>
          </div>
        </div>
        {actionError ? <Banner tone="danger">{messageOf(actionError)}</Banner> : null}

        {draft.lines.length === 0 ? (
          <EmptyState title={copy.noLines} />
        ) : (
          <div className={styles.work}>
            <OrderSheet
              lines={draft.lines}
              checked={derived.checked}
              locked={locked}
              pickedId={pickedId}
              onPick={setPicked}
              ticked={ticked}
              onTick={tick}
              onTickAll={(next) => setTicked(next ? new Set(draft.lines.map((l) => l.id)) : new Set())}
              onEdit={editLine}
              actions={
                !locked ? (
                  <Button variant="default" size="sm" className={styles.refresh} busy={refresh.isPending} onClick={bringIn}>
                    {refresh.isPending ? copy.refreshing : copy.refresh}
                  </Button>
                ) : null
              }
              bar={!locked && ticked.size > 0 ? <BulkBar count={ticked.size} onApply={applyBulk} onClear={() => setTicked(new Set())} /> : null}
              foot={foot}
            />
            {pickedAt >= 0 ? (
              <LineDetail
                key={pickedId}
                line={draft.lines[pickedAt]!}
                checked={derived.checked[pickedAt]!}
                n={pickedAt + 1}
                measurementId={view.windowMeasurementId}
                locked={locked}
                onEdit={(edit) => editLine(pickedId!, edit)}
              />
            ) : (
              <Panel as="aside" title={copy.detailLabel}>
                <p className={styles.note}>{copy.nothingPicked}</p>
              </Panel>
            )}
          </div>
        )}

        <OrderSummary totals={derived.totals} groups={derived.groups} />
      </div>
    </OrderFrame>
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
    <Button variant="default" href={windowsHref(measurementId)}>
      {copy.back}
    </Button>
  );

  if (query.data) return <Editor key={query.data.id} view={query.data} onResync={() => void query.refetch()} />;
  if (create.isError) {
    if (create.error instanceof ApiError && create.error.status === 422) {
      return (
        <OrderFrame address={null}>
          <div className={styles.centre}>
            <EmptyState title={copy.noPhotoWindowsTitle} body={create.error.message !== '' ? create.error.message : copy.noPhotoWindowsBody} action={back} />
          </div>
        </OrderFrame>
      );
    }
    return (
      <OrderFrame address={null}>
        <div className={styles.centre}>
          <EmptyState
            title={copy.loadFailed}
            body={messageOf(create.error)}
            action={
              <Button onClick={() => create.mutate()}>
                {copy.tryAgain}
              </Button>
            }
          />
        </div>
      </OrderFrame>
    );
  }
  if (query.isError) {
    return (
      <OrderFrame address={null}>
        <div className={styles.centre}>
          <EmptyState title={copy.loadFailed} body={messageOf(query.error)} action={back} />
        </div>
      </OrderFrame>
    );
  }
  return (
    <OrderFrame address={null}>
      <div className={styles.centre} role="status">
        <p className={styles.preparing}>{none ? copy.preparing : copy.loading}</p>
        {none ? <p className={styles.note}>{copy.preparingBody}</p> : null}
        <Skeleton lines={4} height="1.25rem" width="min(480px, 90%)" />
      </div>
    </OrderFrame>
  );
}

/** The factory order for a window measurement: /estimator/windows/:windowMeasurementId/order. */
export function OrderWindow() {
  const { windowMeasurementId = '' } = useParams();
  return <OrderBody key={windowMeasurementId} measurementId={windowMeasurementId} />;
}
