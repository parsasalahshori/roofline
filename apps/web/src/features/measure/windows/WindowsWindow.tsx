import { Banner, Button, EmptyState, Field, Icon, Listbox, PageSlotsContext, Panel, PrecisionLadder, Segmented, type SegmentedOption } from '@roofline/ui';
import {
  priceWindows,
  RULER_KINDS,
  RULER_MAX_IN,
  RULER_MIN_IN,
  RULER_SIZES,
  WINDOW_SIZE_CLASSES,
  type DoorRuler,
  type MarkedBox,
  type RulerKind,
  type PhotoWindowInput,
  type Tier,
  type WindowMeasurementPatch,
  type WindowMeasurementView,
  type WindowQuote,
  type WindowSizeClass,
} from '@roofline/shared';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiError } from '../../../api/client.ts';
import { liftMeasure, liftProposal } from '../../../copy/liftMeasure.ts';
import { measureWindows as copy, windowPhotos } from '../../../copy/measureWindows.ts';
import { measureAddressHref, splitAddress } from '../address.ts';
import { readHandoff, type MeasureHandoff } from '../handoff.ts';
import { MeasureHost, MeasurePage, MeasureSteps } from '../MeasurePage.tsx';
import { useGuttersLink } from '../useGuttersLink.ts';
import { ScanBar } from '../lift/ScanBar.tsx';
import { stageAt, useScan } from '../lift/scan.ts';
import { pickedOption, TierPanel, type TierOption } from '../lift/ProposalPanel.tsx';
import { wholeDollars } from '../lift/proposalLines.ts';
import panelStyles from '../lift/ProposalPanel.module.css';
import { useCompany } from '../../settings/api.ts';
import { useWindowCatalog } from '../../settings/window-catalog-api.ts';
import { photoSrc, useCreateWindowMeasurement, usePatchWindowMeasurement, useWindowMeasurement, useWindowPreview } from './api.ts';
import { ElevationDrawing } from './ElevationDrawing.tsx';
import { liveCounts, newMarkId, readAdjustments, rulerSizeLabel, shownWindows, tiersFromQuotes, totalOf, type Box, type Corners } from './model.ts';
import { OrderStatusChip } from './order/OrderChip.tsx';
import { PhotoStage, wallDrawn, type StageEdit } from './PhotoStage.tsx';
import { usePhotoEngine } from './photoEngine.tsx';
import { livePhotoWindows, type LocalSheetSize } from './photoModel.ts';
import { PhotoWindowsFlow, useWindowUploads, type FlowAt } from './PhotoWindows.tsx';
import { usePhotoWindowDrafts } from './photoDrafts.ts';
import { buildRows, drawnWindows, firstToMeasureAgain, gradeCounts, photoGroups, type Combine } from './rows.ts';
import { WallsPlan } from './WallsPlan.tsx';
import { WindowsTable } from './WindowsTable.tsx';
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
type Snapshot = Pick<Adj, 'marked' | 'wallCorners' | 'ruler'>;

/** How a ruler reads: its kind's name and its size ("Garage door", "16 × 7 ft"). */
function rulerWords(r: Pick<DoorRuler, 'kind' | 'widthIn' | 'heightIn'>): { kind: string; size: string } {
  return { kind: copy.rulerKind[r.kind], size: rulerSizeLabel(r.widthIn, r.heightIn, r.kind) };
}

/**
 * Adjust's "Door as a ruler": which door (garage door first: it is flush with its wall), its standard size or a
 * custom one, then Mark the door on the photo. Once the server has applied it: what it was sized with and how.
 */
function RulerPanel({
  id,
  ruler,
  applied,
  marking,
  onMark,
  onChange,
  onRemove,
}: {
  id: string;
  ruler: DoorRuler | null;
  applied: WindowMeasurementView['ruler'];
  marking: boolean;
  onMark: (next: boolean) => void;
  onChange: (size: Pick<DoorRuler, 'kind' | 'widthIn' | 'heightIn'>) => void;
  onRemove: () => void;
}) {
  const [kind, setKind] = useState<RulerKind>(ruler?.kind ?? 'garage-door');
  const [index, setIndex] = useState(() =>
    ruler === null || ruler.kind === 'custom' ? 0 : Math.max(0, RULER_SIZES[ruler.kind].findIndex((z) => z.widthIn === ruler.widthIn && z.heightIn === ruler.heightIn)),
  );
  const [custom, setCustom] = useState({ w: String(ruler?.kind === 'custom' ? ruler.widthIn : 36), h: String(ruler?.kind === 'custom' ? ruler.heightIn : 80) });
  const inRange = (v: number) => Number.isFinite(v) && v >= RULER_MIN_IN && v <= RULER_MAX_IN;
  /** The size picked: a standard one, or the custom one when both sides are in range. */
  const picked = (k: RulerKind, i: number, c: { w: string; h: string }): Pick<DoorRuler, 'kind' | 'widthIn' | 'heightIn'> | null => {
    if (k !== 'custom') return { kind: k, ...RULER_SIZES[k][i]! };
    const size = { widthIn: Number(c.w), heightIn: Number(c.h) };
    return inRange(size.widthIn) && inRange(size.heightIn) ? { kind: k, ...size } : null;
  };
  const chosen = picked(kind, index, custom);
  const pick = (k: RulerKind, i: number, c: { w: string; h: string }, now = true) => {
    setKind(k);
    setIndex(i);
    setCustom(c);
    const next = picked(k, i, c);
    if (next !== null && now) onChange(next);
  };
  const sizes = kind === 'custom' ? [] : RULER_SIZES[kind];
  const words = applied != null ? rulerWords(applied) : null;
  return (
    <section className={styles.section} aria-labelledby={`ruler-${id}`} data-ruler-panel="">
      <h3 id={`ruler-${id}`} className={styles.sectionTitle}>
        {copy.rulerTitle}
      </h3>
      <p className={styles.hint}>{copy.rulerHint}</p>
      <div className={styles.rulerRow}>
        <Listbox
          label={copy.rulerKindLabel}
          value={kind}
          onChange={(next) => pick(next, 0, custom)}
          options={RULER_KINDS.map((k) => ({ value: k, label: copy.rulerKind[k] }))}
          className={styles.rulerField}
        />
        {kind !== 'custom' ? (
          <Listbox
            label={copy.rulerSizeLabel}
            value={String(index)}
            onChange={(next) => pick(kind, Number(next), custom)}
            options={sizes.map((z, i) => ({ value: String(i), label: rulerSizeLabel(z.widthIn, z.heightIn, kind) }))}
            className={styles.rulerField}
          />
        ) : (
          <>
            <Field
              label={copy.rulerCustomWidth}
              inputMode="numeric"
              value={custom.w}
              onChange={(e) => pick('custom', 0, { ...custom, w: e.currentTarget.value }, false)}
              onBlur={() => pick('custom', 0, custom)}
              className={styles.rulerField}
            />
            <Field
              label={copy.rulerCustomHeight}
              inputMode="numeric"
              value={custom.h}
              onChange={(e) => pick('custom', 0, { ...custom, h: e.currentTarget.value }, false)}
              onBlur={() => pick('custom', 0, custom)}
              className={styles.rulerField}
            />
          </>
        )}
      </div>
      <div className={styles.markRow}>
        <Button
          aria-pressed={marking}
          disabled={chosen === null}
          onClick={() => {
            if (chosen !== null) onChange(chosen);
            onMark(!marking);
          }}
          data-ruler-size={chosen === null ? undefined : `${chosen.widthIn}x${chosen.heightIn}`}
        >
          {marking ? copy.rulerMarkStop : ruler !== null ? copy.rulerMarkAgain : copy.rulerMark}
        </Button>
        {ruler !== null ? (
          <Button variant="ghost" onClick={onRemove}>
            {copy.rulerRemove}
          </Button>
        ) : null}
      </div>
      {marking ? <p className={styles.hint}>{copy.rulerOn}</p> : null}
      {ruler !== null && (applied == null || applied.widthIn !== ruler.widthIn || applied.heightIn !== ruler.heightIn || applied.photoId !== ruler.photoId) ? (
        <p className={styles.hint} role="status">
          {copy.rulerPending}
        </p>
      ) : null}
      {applied != null && words !== null ? (
        <div className={styles.rulerResult} role="status" data-agreement={applied.agreement}>
          <strong>{copy.rulerUsed(words.kind, words.size)}</strong>
          <span>{copy.rulerAssumption(applied.rangeM.before, applied.rangeM.after)}</span>
          {applied.agreement === 'check' ? <span className={styles.rulerWarn}>{copy.rulerCheck}</span> : null}
          {applied.kind === 'front-door' ? <span>{copy.rulerFrontDoorNote}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

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

type View = 'drawing' | 'photo' | 'plan';
type Step = 'start' | 'windows' | 'quote';

/** The phone's pinned bar: the tier picked, how many windows, its total, and the way to the quote. */
function QuoteBar({ options, tier, windows, onOpen }: { options: TierOption[]; tier: Tier | null; windows: number; onOpen: () => void }) {
  const picked = pickedOption(options, tier);
  if (picked === undefined) return null;
  return (
    <div className={styles.quoteBar} data-quote-bar="">
      <div className={styles.quoteBarText}>
        <span className={styles.quoteBarLabel}>{copy.quoteBar.label(liftProposal.tier[picked.tier], windows)}</span>
        <span className={styles.quoteBarTotal}>{wholeDollars(picked.totalCents)}</span>
      </div>
      <Button onClick={onOpen}>
        {copy.quoteBar.open}
        <Icon name="arrow" size={18} />
      </Button>
    </div>
  );
}

/** What the quote column holds before the windows are measured: what it will be, and when it comes (no bars: they would read as a stuck loading state). */
function QuotePlaceholder() {
  return (
    <aside className={styles.placeholder} aria-label={liftProposal.label} data-quote-placeholder="">
      <h2 className={styles.placeholderTitle}>{copy.quoteTitle}</h2>
      <p className={styles.placeholderText}>{copy.quoteWaits}</p>
    </aside>
  );
}

function Loaded({ v }: { v: WindowMeasurementView }) {
  const { phone } = useContext(PageSlotsContext);
  const handoff = readHandoff(useLocation().state);
  // The company's plain window choices, to name each window's style the way the homeowner saw it
  const styleTiles = useWindowCatalog().data?.styleTiles;
  // A house with windows measured on site (photos) shows its work at once: the scan is the reveal of Estimator's own
  // reading, for a house that has nothing else yet. Opening a measured house must not hide the table and the order behind a button.
  const scan = useScan(`windows:${v.id}`, (v.photoWindows ?? []).length === 0);
  const startScan = useRef(scan.start);
  useEffect(() => {
    startScan.current = scan.start;
  });
  useEffect(() => {
    if (handoff.autoScan === true) startScan.current();
  }, [handoff.autoScan]);
  const done = scan.phase === 'done';
  const scanning = scan.phase === 'scanning';

  const patch = usePatchWindowMeasurement(v.id);
  const [adj, setAdj] = useState<Adj>(() => readAdjustments(v.adjustments));
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);
  const [rulerMarking, setRulerMarking] = useState(false);
  // The ruler size picked in the panel, used when the door is marked
  const rulerSize = useRef<Pick<DoorRuler, 'kind' | 'widthIn' | 'heightIn'>>(adj.ruler ?? { kind: 'garage-door', ...RULER_SIZES['garage-door'][0]! });
  const [selected, setSelected] = useState<string | null>(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  // Which view of the front is showing (null: the screen's choice), the step on a phone, the window picked in the table
  const [chosenView, setChosenView] = useState<View | null>(null);
  const [step, setStep] = useState<Step>('windows');
  const [pickedRow, setPickedRow] = useState<string | null | undefined>(undefined);
  const [countsOpen, setCountsOpen] = useState(false);
  const [tier, setTier] = useState<Tier | null>(null);

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
    setHistory((h) => [...h.slice(-UNDO_LIMIT + 1), { marked: adj.marked, wallCorners: adj.wallCorners, ruler: adj.ruler }]);
    setAdj((a) => ({ ...a, ...next }));
    save(next);
  };
  const undo = () => {
    const last = history.at(-1);
    if (last === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setAdj((a) => ({ ...a, ...last }));
    setSelected(null);
    save({
      ...(last.marked !== adj.marked && { marked: last.marked }),
      ...(last.wallCorners !== adj.wallCorners && { wallCorners: last.wallCorners }),
      ...(last.ruler !== adj.ruler && { ruler: last.ruler }),
    });
  };

  // The Street View tools (WINDOWS_STREET_VIEW_TOOLS, off by default): the wall drawn on the photo, its corners, marking
  // windows on it and the door ruler. Off, the photo is a read-only "is this the right house?" picture.
  const tools = v.photoTools === true;
  const photos = v.photos;
  const photo = photos[Math.min(photoIndex, photos.length - 1)] ?? null;
  const shown = useMemo(() => shownWindows(v, adj.marked), [v, adj.marked]);
  const uploads = useWindowUploads(v.id, v.uploads);
  // Photographed windows not yet on the server are kept on this device, so a closed tab does not lose them
  const serverPhotoInputs = useMemo(() => v.adjustments.photoWindows ?? [], [v.adjustments]);
  const drafts = usePhotoWindowDrafts(v.id, serverPhotoInputs, (list) => {
    setAdj((a) => ({ ...a, photoWindows: list }));
    save({ photoWindows: list });
  });
  const [flowAt, setFlowAt] = useState<FlowAt | null>(null);
  const uploadList = uploads.uploads;
  // Sheet-measured windows sized on this device, until the server's size for the same corners arrives
  const [localSizes, setLocalSizes] = useState<ReadonlyMap<string, LocalSheetSize>>(new Map());
  const photoLive = useMemo(() => livePhotoWindows(adj.photoWindows, v.photoWindows, uploadList, localSizes), [adj.photoWindows, v.photoWindows, uploadList, localSizes]);
  const counts = useMemo(() => liveCounts(v, shown, adj, photoLive), [v, shown, adj, photoLive]);
  const excluded = useMemo(() => new Set(adj.excludedWindowIds), [adj.excludedWindowIds]);
  const numbers = useMemo(() => new Map(shown.map((w, i) => [w.id, i + 1])), [shown]);
  const corners: Corners | null =
    photo === null || !tools ? null : adj.wallCorners?.photoId === photo.id ? adj.wallCorners.corners : (photo.wallOverlay?.corners ?? null);

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
  /** Leave windows out of the quote (all of them if any is in), or put them all back. */
  const toggleMany = (ids: string[]) => {
    const anyIn = ids.some((id) => !excluded.has(id));
    const next = anyIn ? [...adj.excludedWindowIds.filter((x) => !ids.includes(x)), ...ids] : adj.excludedWindowIds.filter((x) => !ids.includes(x));
    setAdj((a) => ({ ...a, excludedWindowIds: next }));
    save({ excludedWindowIds: next });
  };
  /** A photographed window saved (new or edited): shown at once, saved after the pause; the server's size follows. */
  const savePhoto = (input: PhotoWindowInput, local?: LocalSheetSize) => {
    if (local !== undefined) setLocalSizes((m) => new Map(m).set(input.id, local));
    const next = adj.photoWindows.some((w) => w.id === input.id) ? adj.photoWindows.map((w) => (w.id === input.id ? input : w)) : [...adj.photoWindows, input];
    setAdj((a) => ({ ...a, photoWindows: next }));
    save({ photoWindows: next });
    drafts.keep(next);
  };
  const deletePhoto = (which: string | string[]) => {
    const ids = typeof which === 'string' ? [which] : which;
    const next = adj.photoWindows.filter((w) => !ids.includes(w.id));
    const body: WindowMeasurementPatch = { photoWindows: next };
    if (ids.some((id) => excluded.has(id))) body.excludedWindowIds = adj.excludedWindowIds.filter((x) => !ids.includes(x));
    setAdj((a) => ({ ...a, photoWindows: next, excludedWindowIds: body.excludedWindowIds ?? a.excludedWindowIds }));
    save(body);
    drafts.keep(next);
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
    rulerMarking,
    drawRuler: (photoId: string, box: Box) => {
      changeDrawing({ ruler: { photoId, box, ...rulerSize.current } });
      setRulerMarking(false);
    },
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
  const total = t.measured + t.estimated;
  const progress = done ? 1 : scan.phase === 'idle' ? 0 : scan.progress;
  const captured = monthYear(photo?.capturedOn);

  // The windows as the table and the drawing list them
  const groups = photoGroups(adj.photoWindows, windowPhotos.untitled);
  const engine = usePhotoEngine(groups.some((g) => g.members.length > 1));
  const cv = engine.cv;
  const combine = useMemo<Combine | null>(() => (cv === null ? null : (ms) => cv.combine(ms)), [cv]);
  const rows = useMemo(
    () =>
      buildRows({
        inputs: adj.photoWindows,
        live: photoLive,
        street: shown.filter((w) => w.sized !== null),
        counts,
        excluded,
        untitled: windowPhotos.untitled,
        streetName: copy.table.streetName,
        combine,
      }),
    [adj.photoWindows, photoLive, shown, counts, excluded, combine],
  );
  const drawn = useMemo(() => drawnWindows(rows), [rows]);
  const grades = gradeCounts(rows);
  const wanted = pickedRow !== undefined ? pickedRow : done ? firstToMeasureAgain(rows) : null;
  const selectedRow = wanted !== null && rows.some((r) => r.key === wanted) ? wanted : null;
  const covers = t.measured > 0 ? 'sides-and-back' : (v.estimated?.covers ?? 'all-sides');
  const estimate = v.estimated === null ? null : WINDOW_SIZE_CLASSES.reduce((n, c) => n + v.estimated!.bySizeClass[c], 0);
  const floorsFrom = walls?.floorsFrom ?? (v.stories === null ? 'assumed' : 'height-map');
  // The floors as the estimate took them: one is assumed when there are no heights.
  const floors = v.stories ?? (floorsFrom === 'assumed' ? 1 : null);
  // Shown as a range when the estimate is unsure and nothing was measured, photographed or typed in.
  const range = done && t.measured === 0 && !adj.photosCoverAllWindows && estimate !== null && total === estimate ? (v.estimated?.range ?? null) : null;
  const summary = adj.photosCoverAllWindows ? copy.table.summaryFromPhotos(total) : range !== null ? copy.table.summaryRange(range.low, range.high, total) : copy.table.summary(total, t.measured);
  const anyMarked = v.windows.some((w) => w.source === 'marked') || (v.adjustments.marked?.length ?? 0) > 0;
  const anyFound = v.windows.some((w) => (w.source ?? 'detector') === 'detector');
  const foundBy = v.detector === 'stand-in' && anyFound ? copy.foundBy.standIn : anyMarked ? copy.foundBy.marked : anyFound ? copy.foundBy.detector : copy.foundBy.none;
  const basis =
    walls !== null
      ? copy.wallsBasis({
          perimeterFt: walls.perimeterFt,
          wallHeightFt: floorsFrom === 'assumed' ? null : walls.wallHeightFt,
          floors,
          floorsFrom,
          lowWingFt: walls.lowWingFt ?? 0,
          outlineFrom: walls.outlineFrom ?? 'footprint',
          windows: estimate,
          range: v.estimated?.range ?? null,
          covers: v.estimated?.covers ?? 'all-sides',
        })
      : null;
  const reviewReasons = reasons.filter((r) => r !== 'stand-in-detector');
  const estimatedLeft = grades.estimate;

  // Which view of the front shows: the photo while it is being measured (and where its tools are on), else the drawing
  const wantsPhoto = photo !== null && (tools || !done);
  const view: View = chosenView !== null && (chosenView !== 'photo' || photo !== null) && (chosenView !== 'plan' || walls !== null) ? chosenView : wantsPhoto ? 'photo' : 'drawing';
  const viewOptions: SegmentedOption<View>[] = [
    { value: 'drawing', label: copy.elevation.views.drawing },
    // The imagery's date is on the photo itself, so a phone's narrow switch says just Photo
    ...(photo !== null ? [{ value: 'photo' as const, label: captured !== null && !phone ? copy.elevation.photoWhen(captured) : copy.elevation.views.photo }] : []),
    ...(walls !== null ? [{ value: 'plan' as const, label: copy.elevation.views.plan }] : []),
  ];

  const fitChip =
    tools && overlay !== undefined && done ? (
      <div className={styles.fitChip} data-fit={overlay.fit} role="status">
        {overlay.fit === 'good' ? <Icon name="check" size={16} /> : <Icon name="alert" size={16} />}
        <span>{copy.wallFit[overlay.fit]}</span>
        {walls?.wallHeightFt != null && overlay.wallHeightFromPhotoFt !== null ? (
          <span className={styles.fitHeights}>{copy.wallHeights(walls.wallHeightFt, overlay.wallHeightFromPhotoFt)}</span>
        ) : null}
      </div>
    ) : null;

  const notes =
    reviewReasons.length > 0 ? (
      <div className={styles.review} data-tone="review" role="status">
        <Icon name="alert" size={18} />
        <div className={styles.reviewText}>
          <strong>{copy.needsReview}</strong>
          {reviewReasons.map((r) => (
            <span key={r} className={styles.reason} data-reason={r}>
              {!tools && r === 'estimated-from-size' ? copy.estimatedFromSizeNoTools : copy.reviewReason[r]}
            </span>
          ))}
        </div>
      </div>
    ) : null;

  // Adjust, where the Street View tools are on: the wall's corners, marking windows on the photo, the door ruler
  const adjustPanels =
    tools && photo !== null ? (
      <div className={styles.adjust}>
        {corners !== null ? (
          <section className={styles.section} aria-labelledby={`wall-${v.id}`}>
            <h3 id={`wall-${v.id}`} className={styles.sectionTitle}>
              {copy.wallTitle}
            </h3>
            <p className={styles.hint}>{copy.wallHint}</p>
            {adj.wallCorners !== null ? (
              <Button variant="ghost" onClick={() => changeDrawing({ wallCorners: null })}>
                {copy.wallReset}
              </Button>
            ) : null}
          </section>
        ) : null}
        <section className={styles.section} aria-labelledby={`mark-${v.id}`}>
          <h3 id={`mark-${v.id}`} className={styles.sectionTitle}>
            {copy.markTitle}
          </h3>
          <p className={styles.hint}>{copy.markHint}</p>
          <div className={styles.markRow}>
            <Button
              aria-pressed={marking}
              onClick={() => {
                setMarking((m) => !m);
                setRulerMarking(false);
              }}
            >
              {marking ? copy.markStop : copy.markStart}
            </Button>
            <Button id={`undo-${v.id}`} variant="ghost" disabled={history.length === 0} onClick={undo}>
              {copy.undo}
            </Button>
          </div>
          {marking ? <p className={styles.hint}>{copy.keysHint}</p> : null}
          <p className={styles.hint}>{copy.zoomHint}</p>
        </section>
        <RulerPanel
          id={v.id}
          ruler={adj.ruler}
          applied={v.ruler ?? null}
          marking={rulerMarking}
          onMark={(next) => {
            setRulerMarking(next);
            if (next) {
              setMarking(false);
              setSelected(null);
            }
          }}
          onChange={(size) => {
            rulerSize.current = size;
            const r = adj.ruler;
            if (r !== null && (r.kind !== size.kind || r.widthIn !== size.widthIn || r.heightIn !== size.heightIn)) changeDrawing({ ruler: { ...r, ...size } });
          }}
          onRemove={() => {
            setRulerMarking(false);
            changeDrawing({ ruler: null });
          }}
        />
        <Button
          variant="ghost"
          onClick={() => {
            setEditing(false);
            setMarking(false);
            setRulerMarking(false);
            setSelected(null);
          }}
        >
          {copy.done}
        </Button>
      </div>
    ) : null;

  const photoView =
    photo !== null ? (
      <div className={styles.photoView} data-editing={editing ? 'true' : 'false'}>
        <div className={styles.chips}>
          <span
            className={styles.chip}
            data-tone={scanning || patch.isPending ? 'measuring' : undefined}
            data-right-house={!tools && done ? '' : undefined}
          >
            {scanning
              ? copy.measuringChip
              : !tools && done
                ? copy.rightHouse(captured)
                : captured !== null
                  ? copy.imageryCaptured(captured)
                  : copy.imageryPlain}
          </span>
          {fitChip}
          {tools && v.ruler != null && done ? (
            <span className={styles.chip} data-ruler-chip="" role="status">
              {copy.rulerUsed(rulerWords(v.ruler).kind, rulerWords(v.ruler).size)}
            </span>
          ) : null}
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
          ruler={tools && adj.ruler !== null && adj.ruler.photoId === photo.id ? adj.ruler : null}
          rulerLabel={tools && adj.ruler !== null ? copy.rulerBoxLabel(rulerWords(adj.ruler).kind, rulerWords(adj.ruler).size) : null}
        />
        {marking && editing ? (
          <p className={styles.markOn} role="status">
            {copy.markOn}
          </p>
        ) : null}
        {editing && done ? adjustPanels : null}
      </div>
    ) : null;

  const options = quoteOptions(quotes);
  const stage = stageAt(progress);
  const stageText = stage === 'tracing' ? copy.stage.tracing(v.walls?.perimeterFt ?? null) : copy.stage[stage];
  const tookMs = v.tookMs > 0 ? v.tookMs : scan.totalMs;
  const address = splitAddress(v.address);
  const subtitle: ReactNode = scanning ? (
    <>
      <span role="status">{stageText}</span> {copy.headDot} {liftMeasure.seconds(scan.elapsedMs / 1000)}
    </>
  ) : scan.phase === 'idle' ? (
    address.rest
  ) : (
    [address.rest, floors !== null ? copy.headFloors(floors) : null, walls !== null ? copy.headWall(walls.perimeterFt) : null, copy.headMeasured(tookMs / 1000)]
      .filter((part): part is string => part !== null && part !== '')
      .join(` ${copy.headDot} `)
  );

  const actions = (
    <>
      <Button variant="default" onClick={() => setFlowAt({ step: 'capture' })}>
        <Icon name="camera" size={18} />
        {windowPhotos.add}
      </Button>
      <OrderStatusChip measurementId={v.id} hasPhotoWindows={(v.photoWindows ?? []).length > 0} />
    </>
  );

  const active: Step = step === 'quote' && !done ? 'windows' : step;
  const gutters = useGuttersLink(v.address);

  return (
    <MeasurePage section="windows" address={v.address} subtitle={subtitle} actions={actions} links={{ roof: measureAddressHref(v.address), windows: `/estimator/windows/${encodeURIComponent(v.id)}`, gutters }}>
      <MeasureHost stepsBelow={600} data-measure-windows="">
        <MeasureSteps
          label={copy.steps.label}
          value={active}
          onChange={setStep}
          steps={[
            { key: 'start', label: copy.steps.start, done: true },
            { key: 'windows', label: copy.steps.windows, done: done },
            { key: 'quote', label: copy.steps.quote, disabled: !done },
          ]}
        />
        <div className={styles.work} data-step={active} data-proposal={done ? 'true' : 'false'}>
          <aside className={styles.start}>
            <WindowsStart openAddress={v.address} />
          </aside>
          <div className={styles.main}>
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
            <section className={styles.card} aria-label={copy.statsLabel} data-windows-card="" data-phase={scan.phase} data-editing={editing ? 'true' : 'false'}>
              <Panel
                title={copy.elevation.title}
                padded={false}
                headingLevel={2}
                className={styles.elevation}
                actions={
                  <div className={styles.viewTools}>
                    {viewOptions.length > 1 ? <Segmented label={copy.elevation.views.label} value={view} onChange={setChosenView} options={viewOptions} size="sm" /> : null}
                    {tools && photo !== null && view === 'photo' && done ? (
                      <Button
                        variant="default"
                        size="sm"
                        aria-expanded={editing}
                        onClick={() => {
                          setEditing(!editing);
                          if (editing) {
                            setMarking(false);
                            setRulerMarking(false);
                            setSelected(null);
                          }
                        }}
                      >
                        {copy.adjust}
                      </Button>
                    ) : null}
                    {done ? (
                      <Button variant="quiet" size="sm" className={styles.replay} title={copy.replayScan} onClick={scan.restart}>
                        <Icon name="refresh" size={16} />
                        <span className={styles.replayText}>{copy.replayScan}</span>
                      </Button>
                    ) : null}
                  </div>
                }
              >
                <div className={styles.viewArea} data-view={view}>
                  {view === 'photo' && photoView !== null ? (
                    photoView
                  ) : view === 'plan' && walls !== null ? (
                    <WallsPlan walls={walls} drawn={wallDrawn(progress)} floors={floors} />
                  ) : (
                    <>
                      <ElevationDrawing
                        wallFt={walls?.frontWallFt ?? null}
                        heightFt={walls?.wallHeightFt ?? null}
                        floors={v.stories}
                        windows={drawn}
                        progress={progress}
                        selectedKey={selectedRow}
                        onSelect={(key) => setPickedRow(key)}
                        label={copy.elevation.label(drawn.length)}
                      />
                      {done && drawn.length > 0 ? <p className={styles.scaleNote}>{copy.elevation.scale}</p> : null}
                    </>
                  )}
                  {scan.phase === 'idle' ? <ScanBar scan={scan} introName={copy.scanIntroName} introRest={copy.scanIntroRest} button={copy.scanButton} /> : null}
                </div>
                {done ? (
                  <div className={styles.ladder}>
                    <PrecisionLadder
                      layout="strip"
                      label={copy.ladder.label}
                      total={total}
                      ofLabel={copy.ladder.of}
                      rungs={[
                        { key: 'estimate', label: phone ? copy.ladder.estimatePhone : copy.ladder.estimate, note: copy.ladder.estimateNote, count: grades.estimate },
                        { key: 'quote', label: copy.ladder.quote, note: copy.ladder.quoteNote, count: grades.quote },
                        { key: 'order', label: copy.ladder.order, note: copy.ladder.orderNote, count: grades.order },
                      ]}
                    />
                  </div>
                ) : null}
              </Panel>
              {done ? (
                <>
                  {notes}
                  {v.estimated === null && t.estimated === 0 ? <Banner tone="info">{copy.noEstimate}</Banner> : null}
                  <Panel title={copy.table.label} padded={false} headingLevel={2} className={styles.windows}>
                    {uploads.waiting > 0 ? (
                      <p className={styles.waiting} role="status" data-uploads-waiting={uploads.waiting}>
                        {windowPhotos.photosWaiting(uploads.waiting)}
                      </p>
                    ) : null}
                    <WindowsTable
                      rows={rows}
                      selectedKey={selectedRow}
                      onSelect={(key) => setPickedRow(key)}
                      summary={summary}
                      covers={covers}
                      countsOpen={countsOpen}
                      onCountsOpen={setCountsOpen}
                      styleTiles={styleTiles}
                      actions={{
                        onMeasureAgain: (row) => (row.open?.uploadId !== undefined ? setFlowAt({ step: 'measure', uploadId: row.open.uploadId, windowId: row.open.id }) : undefined),
                        onToggle: toggleMany,
                        onDelete: deletePhoto,
                        onAddPhotos: () => setFlowAt({ step: 'capture' }),
                        estimated: {
                          value: (c) => counts[c].estimated,
                          estimate: (c) => v.estimated?.bySizeClass[c] ?? 0,
                          set: setCount,
                          changed: Object.keys(adj.manualCounts).length > 0,
                          reset: resetCounts,
                        },
                        coverAll: adj.photosCoverAllWindows,
                        onCoverAll: coverAll,
                      }}
                    />
                  </Panel>
                  <Panel title={copy.basisLabel} headingLevel={2} className={styles.facts}>
                    <dl className={styles.factList}>
                      {basis !== null ? (
                        <div className={styles.fact} data-fact="basis">
                          <dt>{copy.basisLabel}</dt>
                          <dd>{basis}</dd>
                        </div>
                      ) : null}
                      <div className={styles.fact} data-fact="floors">
                        <dt>{copy.floorsCell}</dt>
                        <dd>{floors !== null ? copy.floorsWithSource(floors, floorsFrom) : copy.unknown}</dd>
                      </div>
                      <div className={styles.fact}>
                        <dt>{copy.imageryCell}</dt>
                        <dd>{captured ?? copy.unknown}</dd>
                      </div>
                      {tools || anyMarked || anyFound ? (
                        <div className={styles.fact}>
                          <dt>{copy.foundByCell}</dt>
                          <dd>
                            <span className={styles.detectorChip} data-detector={v.detector ?? 'none'}>
                              {foundBy}
                            </span>
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </Panel>
                </>
              ) : null}
            </section>
          </div>
          <div className={styles.quote}>
            {done ? (
              <TierPanel
                title={copy.quoteTitle}
                subline={<p className={panelStyles.squares}>{copy.quoteLine(t.measured + t.estimated, t.measured)}</p>}
                options={options}
                pending={preview.isPending}
                emptyNote={preview.isError ? copy.quoteFailed : copy.noWindows}
                onPick={setTier}
                controls={estimatedLeft > 0 ? <p className={styles.stillEstimates}>{copy.quoteStillEstimates(estimatedLeft)}</p> : null}
                footer={
                  <div className={styles.send}>
                    <Button disabled aria-describedby={`send-note-${v.id}`}>
                      {copy.send}
                      <Icon name="arrow" size={18} />
                    </Button>
                    <p id={`send-note-${v.id}`} className={styles.hint}>
                      {copy.sendNext}
                    </p>
                  </div>
                }
              />
            ) : (
              <QuotePlaceholder />
            )}
          </div>
          {done && active !== 'quote' ? <QuoteBar options={options} tier={tier} windows={total} onOpen={() => setStep('quote')} /> : null}
        </div>
      </MeasureHost>
      {flowAt !== null ? (
        <PhotoWindowsFlow
          at={flowAt}
          go={setFlowAt}
          uploads={uploads}
          inputs={adj.photoWindows}
          saved={v.photoWindows ?? []}
          live={photoLive}
          onSave={savePhoto}
          onDelete={deletePhoto}
          onClose={() => setFlowAt(null)}
        />
      ) : null}
    </MeasurePage>
  );
}

/**
 * An address to measure. `?measure=<address>` (the search's action) or `?property=<id>` (the roof's Windows switch)
 * measures straight away, once; then the new measurement opens with its scan playing.
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
  // The example address is in the company's own town
  const company = useCompany();
  return (
    <Panel title={copy.startTitle} headingLevel={2} className={styles.startPanel}>
      <div className={styles.startBody}>
        {/* With nothing open the steps below say the same first thing, so the line over the form is only for the panel that sits beside an open house */}
        {openAddress !== null ? <p className={styles.hint}>{copy.startSubtitle}</p> : null}
        <form className={styles.startForm} onSubmit={submit}>
          <Field
            label={copy.addressLabel}
            placeholder={copy.addressPlaceholder(company.data?.addressCity ?? null, company.data?.addressState ?? null)}
            autoComplete="off"
            maxLength={300}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
          />
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
        ) : (
          <ol className={styles.startSteps}>
            {copy.startSteps.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        )}
      </div>
    </Panel>
  );
}

/** Measure windows: the address, the front of the house drawn from what was measured with its windows, and the quote. */
export function WindowsWindow() {
  const { windowMeasurementId = '' } = useParams();
  const query = useWindowMeasurement(windowMeasurementId);
  const v = query.data;
  const gutters = useGuttersLink(null);
  if (v !== undefined && windowMeasurementId !== '') return <Loaded key={v.id} v={v} />;
  const links = { roof: '/estimator', windows: '/estimator/windows', gutters };
  return (
    <MeasurePage section="windows" title={copy.title} subtitle={copy.subtitle} links={links}>
      <MeasureHost data-measure-windows="">
        {windowMeasurementId === '' ? (
          <div className={styles.startOnly}>
            <WindowsStart openAddress={null} />
          </div>
        ) : query.isError ? (
          <EmptyState title={copy.loadFailed} />
        ) : (
          <p className={styles.loading} role="status">
            {copy.loading}
          </p>
        )}
      </MeasureHost>
    </MeasurePage>
  );
}
