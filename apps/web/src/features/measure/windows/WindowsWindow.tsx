import { Banner, Button, Checkbox, EmptyState, Field } from '@roofline/ui';
import {
  priceWindows,
  WINDOW_SIZE_CLASSES,
  type MarkedBox,
  type PhotoWindowInput,
  type WindowMeasurementPatch,
  type WindowMeasurementView,
  type WindowQuote,
  type WindowSizeClass,
} from '@roofline/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { liftProposal } from '../../../copy/liftMeasure.ts';
import { measureWindows as copy, windowPhotos } from '../../../copy/measureWindows.ts';
import { measureAddressHref } from '../address.ts';
import { readHandoff, type MeasureHandoff } from '../handoff.ts';
import frame from '../MeasureWindow.module.css';
import cardStyles from '../lift/MeasureCard.module.css';
import { ScanBar } from '../lift/ScanBar.tsx';
import { useScan } from '../lift/scan.ts';
import { TierPanel, type TierOption } from '../lift/ProposalPanel.tsx';
import { wholeDollars } from '../lift/proposalLines.ts';
import panelStyles from '../lift/ProposalPanel.module.css';
import { photoSrc, useCreateWindowMeasurement, usePatchWindowMeasurement, useWindowMeasurement, useWindowPreview } from './api.ts';
import { liveCounts, newMarkId, readAdjustments, shownWindows, tiersFromQuotes, totalOf, type Box, type Corners } from './model.ts';
import { PhotoStage, wallDrawn, type StageEdit } from './PhotoStage.tsx';
import { livePhotoWindows } from './photoModel.ts';
import { PhotoWindowsFlow, PhotoWindowsList, useWindowUploads, type FlowAt } from './PhotoWindows.tsx';
import { WallsPlan, WindowsCard } from './WindowsCard.tsx';
import { MeasureSwitch } from './MeasureSwitch.tsx';
import styles from './WindowsWindow.module.css';

export const SAVE_DEBOUNCE_MS = 500;
const UNDO_LIMIT = 50;

/** 'YYYY-MM' as "Jun 2024". */
function monthYear(capturedOn: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(capturedOn ?? '');
  if (m === null) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

type Adj = ReturnType<typeof readAdjustments>;
type Snapshot = Pick<Adj, 'marked' | 'wallCorners'>;

function quoteOptions(quotes: WindowQuote[]): TierOption[] {
  return quotes.map((q) => ({
    tier: q.tier,
    name: q.name,
    note: q.description,
    totalCents: q.totalCents,
    monthlyCents: null,
    groups: [
      {
        title: copy.quoteGroup(liftProposal.tier[q.tier]),
        lines: q.lines.map((l) => ({
          key: l.sizeClass,
          name: copy.quoteLineName(copy.sizeClass[l.sizeClass]),
          quantity: copy.quoteLineQty(l.count, wholeDollars(l.unitCents)),
          cents: l.amountCents,
        })),
      },
    ],
    finance: null,
  }));
}

function Stepper({ cls, value, estimate, onChange }: { cls: WindowSizeClass; value: number; estimate: number; onChange: (next: number) => void }) {
  const name = copy.sizeClass[cls];
  return (
    <div className={styles.stepper} data-stepper={cls}>
      <span className={styles.stepperName}>
        {name}
        <span className={styles.classHint}>{copy.sizeClassHint[cls]}</span>
      </span>
      <Button variant="ghost" className={styles.stepButton} aria-label={copy.stepDown(name)} disabled={value <= 0} onClick={() => onChange(value - 1)}>
        {copy.minus}
      </Button>
      <output className={styles.stepValue} aria-label={copy.stepValue(name)} data-changed={value !== estimate ? 'true' : undefined}>
        {value}
      </output>
      <Button variant="ghost" className={styles.stepButton} aria-label={copy.stepUp(name)} onClick={() => onChange(value + 1)}>
        {copy.plus}
      </Button>
    </div>
  );
}

function Loaded({ v, onQuoteReady }: { v: WindowMeasurementView; onQuoteReady: (ready: boolean) => void }) {
  const handoff = readHandoff(useLocation().state);
  const scan = useScan(`windows:${v.id}`, true);
  const startScan = useRef(scan.start);
  useEffect(() => {
    startScan.current = scan.start;
  });
  useEffect(() => {
    if (handoff.autoScan === true) startScan.current();
  }, [handoff.autoScan]);
  const done = scan.phase === 'done';
  useEffect(() => onQuoteReady(done), [done, onQuoteReady]);

  const patch = usePatchWindowMeasurement(v.id);
  const [adj, setAdj] = useState<Adj>(() => readAdjustments(v.adjustments));
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState(0);

  // Saves: each change goes into `pending`; 500 ms after the last one, one PATCH carries them all
  const pending = useRef<WindowMeasurementPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mutateRef = useRef(patch.mutate);
  useEffect(() => {
    mutateRef.current = patch.mutate;
  });
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const body = pending.current;
    pending.current = {};
    if (Object.keys(body).length > 0) mutateRef.current(body);
  }, []);
  useEffect(() => () => flush(), [flush]);
  const save = (body: WindowMeasurementPatch) => {
    Object.assign(pending.current, body);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  /** A change to the marks or the wall's corners: kept for Undo, shown at once, saved after the pause. */
  const changeDrawing = (next: Partial<Snapshot>) => {
    setHistory((h) => [...h.slice(-UNDO_LIMIT + 1), { marked: adj.marked, wallCorners: adj.wallCorners }]);
    setAdj((a) => ({ ...a, ...next }));
    save(next);
  };
  const undo = () => {
    const last = history.at(-1);
    if (last === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setAdj((a) => ({ ...a, ...last }));
    setSelected(null);
    save({ ...(last.marked !== adj.marked && { marked: last.marked }), ...(last.wallCorners !== adj.wallCorners && { wallCorners: last.wallCorners }) });
  };

  const photos = v.photos;
  const photo = photos[Math.min(photoIndex, photos.length - 1)] ?? null;
  const shown = useMemo(() => shownWindows(v, adj.marked), [v, adj.marked]);
  const uploads = useWindowUploads(v.id, v.uploads);
  const [flowAt, setFlowAt] = useState<FlowAt | null>(null);
  const uploadList = uploads.uploads;
  const photoLive = useMemo(() => livePhotoWindows(adj.photoWindows, v.photoWindows, uploadList), [adj.photoWindows, v.photoWindows, uploadList]);
  const counts = useMemo(() => liveCounts(v, shown, adj, photoLive), [v, shown, adj, photoLive]);
  const excluded = useMemo(() => new Set(adj.excludedWindowIds), [adj.excludedWindowIds]);
  const numbers = useMemo(() => new Map(shown.map((w, i) => [w.id, i + 1])), [shown]);
  const corners: Corners | null =
    photo === null ? null : adj.wallCorners?.photoId === photo.id ? adj.wallCorners.corners : (photo.wallOverlay?.corners ?? null);

  const version = JSON.stringify([v.adjustments, v.windows.map((w) => `${w.id}:${w.sizeClass}`), v.estimated?.bySizeClass ?? null]);
  const preview = useWindowPreview(v.id, version);
  const quotes = useMemo(
    () => (preview.data === undefined ? [] : priceWindows(counts, tiersFromQuotes(preview.data.quotes))),
    [counts, preview.data],
  );

  const toggle = (id: string) => {
    const next = excluded.has(id) ? adj.excludedWindowIds.filter((x) => x !== id) : [...adj.excludedWindowIds, id];
    setAdj((a) => ({ ...a, excludedWindowIds: next }));
    save({ excludedWindowIds: next });
  };
  const setCount = (cls: WindowSizeClass, value: number) => {
    const next = { ...adj.manualCounts, [cls]: Math.max(0, value) };
    setAdj((a) => ({ ...a, manualCounts: next }));
    save({ manualCounts: next });
  };
  /** A photographed window saved (new or edited): shown at once, saved after the pause; the server's size follows. */
  const savePhoto = (input: PhotoWindowInput) => {
    const next = adj.photoWindows.some((w) => w.id === input.id) ? adj.photoWindows.map((w) => (w.id === input.id ? input : w)) : [...adj.photoWindows, input];
    setAdj((a) => ({ ...a, photoWindows: next }));
    save({ photoWindows: next });
  };
  const deletePhoto = (id: string) => {
    const next = adj.photoWindows.filter((w) => w.id !== id);
    const body: WindowMeasurementPatch = { photoWindows: next };
    if (excluded.has(id)) body.excludedWindowIds = adj.excludedWindowIds.filter((x) => x !== id);
    setAdj((a) => ({ ...a, photoWindows: next, excludedWindowIds: body.excludedWindowIds ?? a.excludedWindowIds }));
    save(body);
  };
  const coverAll = (next: boolean) => {
    setAdj((a) => ({ ...a, photosCoverAllWindows: next }));
    save({ photosCoverAllWindows: next });
  };
  const resetCounts = () => {
    setAdj((a) => ({ ...a, manualCounts: {} }));
    save({ manualCounts: {} });
  };

  const edit: StageEdit = {
    editing,
    marking,
    locked: false,
    selected,
    select: setSelected,
    toggle,
    draw: (photoId: string, box: Box) => {
      const mark: MarkedBox = { id: newMarkId(), photoId, box };
      changeDrawing({ marked: [...adj.marked, mark] });
      setSelected(mark.id);
    },
    changeBox: (id, box) => changeDrawing({ marked: adj.marked.map((m) => (m.id === id ? { ...m, box } : m)) }),
    remove: (id) => {
      changeDrawing({ marked: adj.marked.filter((m) => m.id !== id) });
      setSelected(null);
    },
    moveCorners: (photoId, next) => changeDrawing({ wallCorners: { photoId, corners: next } }),
  };

  // Keyboard: Escape stops marking or clears the selection; Ctrl/Cmd+Z undoes
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        document.getElementById(`undo-${v.id}`)?.click();
      } else if (e.key === 'Escape') {
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, v.id]);

  const reasons = v.needsReview?.reasons ?? [];
  const standIn = v.detector === 'stand-in' || reasons.includes('stand-in-detector');
  const overlay = photo?.wallOverlay;
  const walls = v.walls ?? null;
  const t = totalOf(counts);
  const progress = done ? 1 : scan.phase === 'idle' ? 0 : scan.progress;
  const captured = monthYear(photo?.capturedOn);
  const measuredShown = shown.filter((w) => w.sized !== null || w.source === 'marked');

  const notes =
    reasons.filter((r) => r !== 'stand-in-detector').length > 0 ? (
      <div className={cardStyles.note} data-tone="review" role="status">
        <strong>{copy.needsReview}</strong>
        {reasons
          .filter((r) => r !== 'stand-in-detector')
          .map((r) => (
            <span key={r} className={cardStyles.reason} data-reason={r}>
              {copy.reviewReason[r]}
            </span>
          ))}
      </div>
    ) : null;

  const panels = (
    <>
      <section className={frame.panel}>
        <Button variant="ghost" className={frame.wide} onClick={() => setFlowAt({ step: 'capture' })}>
          {windowPhotos.add}
        </Button>
      </section>
      {corners !== null && photo !== null ? (
        <section className={frame.panel} aria-labelledby={`wall-${v.id}`}>
          <h3 id={`wall-${v.id}`} className={frame.title}>
            {copy.wallTitle}
          </h3>
          <p className={frame.hint}>{copy.wallHint}</p>
          {adj.wallCorners !== null ? (
            <Button variant="ghost" className={frame.wide} onClick={() => changeDrawing({ wallCorners: null })}>
              {copy.wallReset}
            </Button>
          ) : null}
        </section>
      ) : null}
      {photo !== null ? (
        <section className={frame.panel} aria-labelledby={`mark-${v.id}`}>
          <h3 id={`mark-${v.id}`} className={frame.title}>
            {copy.markTitle}
          </h3>
          <p className={frame.hint}>{copy.markHint}</p>
          <div className={styles.markRow}>
            <Button aria-pressed={marking} onClick={() => setMarking((m) => !m)}>
              {marking ? copy.markStop : copy.markStart}
            </Button>
            <Button id={`undo-${v.id}`} variant="ghost" disabled={history.length === 0} onClick={undo}>
              {copy.undo}
            </Button>
          </div>
          {marking ? <p className={frame.hint}>{copy.keysHint}</p> : null}
        </section>
      ) : null}
      {measuredShown.length > 0 ? (
        <section className={frame.panel} aria-labelledby={`front-${v.id}`}>
          <h3 id={`front-${v.id}`} className={frame.title}>
            {copy.measuredTitle}
          </h3>
          <p className={frame.hint}>{copy.measuredHint}</p>
          <ul className={styles.windowList}>
            {measuredShown.map((w) => (
              <li key={w.id}>
                <Checkbox
                  label={`${copy.includeWindow(numbers.get(w.id) ?? 0)} · ${w.sized !== null ? copy.size(w.sized.widthIn, w.sized.heightIn) : copy.sizing}`}
                  checked={!excluded.has(w.id)}
                  onChange={() => toggle(w.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className={frame.panel} aria-labelledby={`est-${v.id}`}>
        <h3 id={`est-${v.id}`} className={frame.title}>
          {t.measured > 0 ? copy.estimatedTitle : copy.estimatedAllTitle}
        </h3>
        <p className={frame.hint}>{copy.estimatedHint}</p>
        {WINDOW_SIZE_CLASSES.map((c) => (
          <Stepper key={c} cls={c} value={counts[c].estimated} estimate={v.estimated?.bySizeClass[c] ?? 0} onChange={(n) => setCount(c, n)} />
        ))}
        {Object.keys(adj.manualCounts).length > 0 ? (
          <Button variant="ghost" className={frame.wide} onClick={resetCounts}>
            {copy.resetCounts}
          </Button>
        ) : null}
        <p className={frame.hint}>{copy.sizeClassRule}</p>
      </section>
    </>
  );

  const fitChip =
    overlay !== undefined && done ? (
      <div className={styles.fitChip} data-fit={overlay.fit} role="status">
        {overlay.fit === 'good' ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
            <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
        <span>{copy.wallFit[overlay.fit]}</span>
        {walls?.wallHeightFt != null && overlay.wallHeightFromPhotoFt !== null ? (
          <span className={styles.fitHeights}>{copy.wallHeights(walls.wallHeightFt, overlay.wallHeightFromPhotoFt)}</span>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <main className={frame.main}>
        <div className={styles.strip}>
          <h3 className={styles.address}>{v.address}</h3>
        </div>
        <div className={styles.stage} data-phase={scan.phase} data-editing={editing ? 'true' : 'false'} data-photo={photo === null ? 'none' : undefined}>
          <div className={styles.stageTop}>
            <div className={styles.chips}>
              <span className={styles.chip} data-tone={scan.phase === 'scanning' || patch.isPending ? 'measuring' : undefined}>
                {scan.phase === 'scanning' ? copy.measuringChip : captured !== null ? copy.imageryCaptured(captured) : copy.imageryPlain}
              </span>
              {fitChip}
              {photos.length > 1 ? (
                <div className={styles.photoPick} role="group" aria-label={copy.photoPick}>
                  {photos.map((ph, i) => (
                    <Button
                      key={ph.id}
                      variant="ghost"
                      className={styles.photoPickButton}
                      aria-pressed={i === photoIndex}
                      aria-label={copy.photoNumber(i + 1, photos.length)}
                      onClick={() => {
                        setPhotoIndex(i);
                        setSelected(null);
                      }}
                    >
                      {String(i + 1)}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
            {walls !== null && scan.phase !== 'idle' && progress > 0.3 ? <WallsPlan walls={walls} drawn={wallDrawn(progress)} floors={progress >= 0.55 ? v.stories : null} /> : null}
          </div>
          {standIn || v.missing !== null || patch.isError ? (
            <div className={styles.notices}>
              {standIn ? (
                <div className={styles.standIn} role="alert" data-stand-in="">
                  <Banner tone="danger">{copy.standIn}</Banner>
                </div>
              ) : null}
              {v.missing !== null ? (
                <div data-missing={v.missing.reason}>
                  <Banner tone="warning">{copy.missing[v.missing.reason]}</Banner>
                </div>
              ) : null}
              {patch.isError ? <Banner tone="danger">{copy.saveFailed}</Banner> : null}
            </div>
          ) : null}
          {photo !== null ? (
            <PhotoStage
              key={photo.id}
              photo={photo}
              src={photoSrc(v.id, photo.id)}
              address={v.address}
              windows={shown.filter((w) => w.photoId === photo.id)}
              numberOf={(id) => numbers.get(id) ?? 0}
              excluded={excluded}
              corners={corners}
              scan={scan}
              edit={edit}
            />
          ) : (
            <div className={styles.photoArea}>
              <p className={styles.noPhoto}>{copy.noPhoto}</p>
            </div>
          )}
          {marking && editing ? (
            <p className={styles.markOn} role="status">
              {copy.markOn}
            </p>
          ) : null}
          {scan.phase === 'idle' ? (
            <ScanBar scan={scan} introName={copy.scanIntroName} introRest={copy.scanIntroRest} button={copy.scanButton} />
          ) : (
            <WindowsCard
              v={v}
              counts={counts}
              scan={scan}
              tookMs={v.tookMs > 0 ? v.tookMs : scan.totalMs}
              editing={editing}
              onEdit={(next) => {
                setEditing(next);
                if (!next) {
                  setMarking(false);
                  setSelected(null);
                }
              }}
              panels={panels}
              notes={notes}
              captured={captured}
              fromPhotos={adj.photosCoverAllWindows}
              onAddPhotos={() => setFlowAt({ step: 'capture' })}
              photos={
                <PhotoWindowsList
                  windows={photoLive}
                  inputs={adj.photoWindows}
                  excluded={excluded}
                  coverAll={adj.photosCoverAllWindows}
                  srcFor={uploads.srcFor}
                  onOpen={(w) => setFlowAt({ step: 'measure', uploadId: w.uploadId, windowId: w.id })}
                  onToggle={toggle}
                  onDelete={deletePhoto}
                  onCoverAll={coverAll}
                />
              }
            />
          )}
        </div>
      </main>
      {flowAt !== null ? (
        <PhotoWindowsFlow
          at={flowAt}
          go={setFlowAt}
          uploads={uploads}
          inputs={adj.photoWindows}
          saved={v.photoWindows ?? []}
          onSave={savePhoto}
          onDelete={deletePhoto}
          onClose={() => setFlowAt(null)}
        />
      ) : null}
      {done ? (
        <div className={frame.proposal}>
          <TierPanel
            title={copy.quoteTitle}
            subline={<p className={panelStyles.squares}>{copy.quoteLine(t.measured + t.estimated, t.measured)}</p>}
            options={quoteOptions(quotes)}
            pending={preview.isPending}
            emptyNote={preview.isError ? copy.quoteFailed : copy.noWindows}
            footer={
              <div className={frame.actions}>
                <Button className={frame.send} disabled aria-describedby={`send-note-${v.id}`}>
                  {copy.send}
                </Button>
                <p id={`send-note-${v.id}`} className={frame.hint}>
                  {copy.sendNext}
                </p>
              </div>
            }
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * The left column: an address to measure. `?measure=<address>` (the search's action) or `?property=<id>` (the roof's
 * Windows switch) measures straight away, once; then the new measurement opens with its scan playing.
 */
function WindowsStart({ openAddress }: { openAddress: string | null }) {
  const [params, setParams] = useSearchParams();
  const [asked] = useState(() => ({ address: params.get('measure')?.trim() ?? '', propertyId: params.get('property')?.trim() ?? '' }));
  const [text, setText] = useState(asked.address);
  const navigate = useNavigate();
  const create = useCreateWindowMeasurement();
  const go = (body: { address: string } | { propertyId: string }) =>
    create.mutate(body, {
      onSuccess: (created) => void navigate(`/estimator/windows/${encodeURIComponent(created.id)}`, { state: { autoScan: true } satisfies MeasureHandoff }),
      onError: () =>
        setParams(
          (current) => {
            const next = new URLSearchParams(current);
            next.delete('measure');
            next.delete('property');
            return next;
          },
          { replace: true },
        ),
    });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (asked.propertyId !== '') go({ propertyId: asked.propertyId });
    else if (asked.address !== '') go({ address: asked.address });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for what the window opened with
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() !== '' && !create.isPending) go({ address: text.trim() });
  };
  const failed = create.error instanceof ApiError && create.error.message !== '' ? create.error.message : copy.measureFailed;
  return (
    <section className={styles.start} aria-labelledby="windows-start-title">
      <h2 id="windows-start-title" className={styles.startTitle}>
        {copy.startTitle}
      </h2>
      <p className={styles.startSubtitle}>{copy.startSubtitle}</p>
      <form className={styles.startForm} onSubmit={submit}>
        <Field label={copy.addressLabel} placeholder={copy.addressPlaceholder} autoComplete="off" maxLength={300} value={text} onChange={(e) => setText(e.currentTarget.value)} />
        <Button type="submit" busy={create.isPending} disabled={text.trim() === '' || create.isPending}>
          {create.isPending ? copy.measuring : copy.measure}
        </Button>
      </form>
      {create.isError ? (
        <div role="alert">
          <Banner tone="danger">{failed}</Banner>
        </div>
      ) : null}
      {openAddress !== null ? (
        <p className={styles.openNow}>
          <span>{copy.opened}</span>
          <strong>{openAddress}</strong>
        </p>
      ) : null}
    </section>
  );
}

type Step = 'start' | 'windows' | 'quote';
const STEPS: Step[] = ['start', 'windows', 'quote'];

/** Measure windows: an address on the left, the photo of the front and its windows in the middle, the quote on the right. */
export function WindowsWindow() {
  const { windowMeasurementId = '' } = useParams();
  const query = useWindowMeasurement(windowMeasurementId);
  const [step, setStep] = useState<Step>(windowMeasurementId === '' ? 'start' : 'windows');
  const [quoteReady, setQuoteReady] = useState(false);
  const [shownId, setShownId] = useState(windowMeasurementId);
  if (shownId !== windowMeasurementId) {
    setShownId(windowMeasurementId);
    setStep(windowMeasurementId === '' ? 'start' : 'windows');
    setQuoteReady(false);
  }
  const active: Step = step === 'quote' && !quoteReady ? 'windows' : step;
  const v = query.data;
  // The roof screen's step names are 'requests' | 'roof' | 'proposal': the shared CSS shows the column by them
  const dataStep = active === 'start' ? 'requests' : active === 'windows' ? 'roof' : 'proposal';

  return (
    <div className={frame.window} data-step={dataStep} data-proposal={quoteReady ? 'true' : 'false'} data-measure-windows="">
      <header className={frame.header}>
        <span className={frame.appIcon} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
            <path d="M4 3h16v18H4zM4 12h16M12 3v18" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className={frame.heading}>{copy.title}</h2>
        <MeasureSwitch current="windows" roofHref={v !== undefined ? measureAddressHref(v.address) : '/estimator'} windowsHref="/estimator/windows" />
        <span className={frame.subtitle}>{copy.subtitle}</span>
      </header>
      <div className={frame.steps} role="tablist" aria-label={copy.steps.label}>
        {STEPS.map((s, i) => (
          <Button
            key={s}
            variant="ghost"
            role="tab"
            aria-selected={active === s}
            data-selected={active === s ? 'true' : undefined}
            disabled={(s === 'windows' && windowMeasurementId === '') || (s === 'quote' && !quoteReady)}
            className={frame.step}
            onClick={() => setStep(s)}
          >
            <span className={frame.stepNumber} aria-hidden="true">
              {i + 1}
            </span>
            {copy.steps[s]}
          </Button>
        ))}
      </div>
      <div className={frame.body}>
        <aside className={frame.list}>
          <WindowsStart openAddress={v?.address ?? null} />
        </aside>
        {windowMeasurementId === '' ? (
          <main className={frame.main}>
            <div className={frame.pick}>
              <EmptyState title={copy.pickAddress} />
            </div>
          </main>
        ) : v !== undefined ? (
          <Loaded key={v.id} v={v} onQuoteReady={setQuoteReady} />
        ) : query.isError ? (
          <main className={frame.main}>
            <EmptyState title={copy.loadFailed} />
          </main>
        ) : (
          <main className={frame.main}>
            <p className={frame.loading}>{copy.loading}</p>
          </main>
        )}
      </div>
    </div>
  );
}
