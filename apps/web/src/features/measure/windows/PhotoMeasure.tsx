import { Banner, Button, Checkbox, Field, Select } from '@roofline/ui';
import {
  photoWindowKey,
  WINDOW_PHOTO_REFERENCES,
  type PhotoWindow,
  type PhotoWindowInput,
  type Quad,
  type SheetDetection,
  type SnappedQuad,
  type WindowPhotoMeasurement,
  type WindowPhotoReference,
  type WindowPhotoScale,
  type WindowPhotoUpload,
} from '@roofline/shared';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { newMarkId } from './model.ts';
import {
  asMeasurement,
  feet1,
  inchesFraction,
  LOW_SIDE_CONFIDENCE,
  ENGINE_TARGET,
  measureOnSheet,
  needsOutlinePick,
  readPrintScale,
  TARGET_LAYER,
  PLANE_TARGETS,
  planeTargetFor,
  plusMinusFraction,
  RETAKE_UNCERTAINTY_IN,
  seedPaperQuad,
  seedWindowQuad,
  sizePhotoWindow,
  sizingKey,
  type LocalSheetSize,
  type PlaneTarget,
} from './photoModel.ts';
import { useSheetPhoto } from './useSheetPhoto.ts';
import styles from './PhotoMeasure.module.css';

type Method = 'sheet' | 'reference' | 'known-side';
type Which = 'window' | 'paper';
type Drag = { which: Which; i: number; x: number; y: number; fw: number; fh: number };
/** The last snap (or proposal): per-side confidence, corner noise, rival edges and the ranked outlines. */
type SnapInfo = Omit<SnappedQuad, 'quad'>;
/** Which ranked outline is shown, and whether the person chose it (else it follows "What are you measuring?"). */
type Pick_ = { index: number; by: 'auto' | 'person' };
const PICK_MAX = 3;
/** Outline A, B, C: distinct on photos of white frames, tan siding and blue glass. */
const PICK_COLORS = ['#ffc21a', '#19c3e6', '#e64bd2'] as const;
const PICK_ZOOM_PX = 64;

const LOUPE_PX = 112;
const LOUPE_ZOOM = 3;
const PAPERS = Object.keys(WINDOW_PHOTO_REFERENCES) as WindowPhotoReference[];
const METHODS: Method[] = ['sheet', 'reference', 'known-side'];
const TARGETS = Object.keys(PLANE_TARGETS) as (keyof typeof PLANE_TARGETS)[];

/** One corner of a quad moved to (x, y), kept on the photo. */
export function moveQuadCorner(q: Quad, i: number, x: number, y: number, w: number, h: number): Quad {
  return q.map((p, j) => (j === i ? [Math.round(Math.min(w, Math.max(0, x)) * 10) / 10, Math.round(Math.min(h, Math.max(0, y)) * 10) / 10] : p)) as Quad;
}

const roundQuad = (q: Quad, w: number, h: number): Quad => q.reduce<Quad>((acc, p, i) => moveQuadCorner(acc, i, p[0], p[1], w, h), q);

/** A window of several photos the person can add this photo to. */
export type WindowGroup = { key: string; name: string };

/**
 * Sizing one photographed window, full screen on a phone. Three ways, best first:
 * - Measuring sheet: the engine finds the printed sheet on the glass, the person checks the window's corners (snapped
 *   onto the frame's edges), says what they are measuring, and gets the size to 1/8 in with its ± and how the photo
 *   was taken (distance, angle, warnings).
 * - Paper on the glass: four corners of a sheet of paper (blue) and the window's four (yellow).
 * - I measured one side: the window's corners and one side typed in.
 * A loupe magnifies the corner being dragged. Save hands the window back to be saved.
 */
export function PhotoMeasure({
  upload,
  src,
  initial,
  saved,
  onSave,
  onCancel,
  onDelete,
  groups = [],
  live = [],
  defaultWindowKey,
}: {
  upload: WindowPhotoUpload;
  src: string;
  /** The window being edited, or null for a new one on this photo. */
  initial: PhotoWindowInput | null;
  /** The server's sized window for `initial`, when it has one. */
  saved: PhotoWindow | null;
  onSave: (input: PhotoWindowInput, local?: LocalSheetSize) => void;
  onCancel: () => void;
  onDelete?: (() => void) | undefined;
  /** Windows already photographed, so this photo can be another photo of one of them. */
  groups?: readonly WindowGroup[];
  /** Every photographed window as sized now (for combining this photo with the other photos of its window). */
  live?: readonly PhotoWindow[];
  /** The window this new photo is of (from "Add another photo of …"). */
  defaultWindowKey?: string | undefined;
}) {
  const W = upload.widthPx;
  const H = upload.heightPx;
  const initialScale = initial?.scale;
  const [method, setMethod] = useState<Method>(initialScale?.kind ?? 'sheet');
  const [windowQuad, setWindowQuad] = useState<Quad>(initial?.corners ?? seedWindowQuad(W, H));
  const [reference, setReference] = useState<WindowPhotoReference>(initialScale?.kind === 'reference' ? initialScale.reference : 'letter');
  const [paperQuad, setPaperQuad] = useState<Quad>(
    initialScale?.kind === 'reference' ? initialScale.corners : seedPaperQuad(W, H, WINDOW_PHOTO_REFERENCES.letter.widthIn / WINDOW_PHOTO_REFERENCES.letter.heightIn),
  );
  const [side, setSide] = useState<'width' | 'height'>(initialScale?.kind === 'known-side' ? initialScale.side : 'width');
  const [inchesText, setInchesText] = useState(initialScale?.kind === 'known-side' ? String(initialScale.inches) : '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [groupKey, setGroupKey] = useState(initial !== null ? photoWindowKey(initial) : (defaultWindowKey ?? ''));
  const startOffset = initialScale?.kind === 'sheet' ? initialScale.planeOffsetIn : PLANE_TARGETS.frame;
  const [offsetIn, setOffsetIn] = useState(startOffset);
  const [offsetText, setOffsetText] = useState(String(startOffset));
  const [snapOn, setSnapOn] = useState(true);
  const [snapping, setSnapping] = useState(false);
  const [snapInfo, setSnapInfo] = useState<SnapInfo | null>(null);
  const [pick, setPick] = useState<Pick_ | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const snapSeq = useRef(0);

  const sheetMode = method === 'sheet';
  const { engine, find, canSnap, snap, propose } = useSheetPhoto({ src, upload, enabled: sheetMode });
  const detection: Pick<SheetDetection, 'paper' | 'imagePoints' | 'sheetPointsIn' | 'sheetIndex' | 'sheets'> | null =
    find.status === 'found'
      ? find.detection
      : initialScale?.kind === 'sheet'
        ? {
            paper: initialScale.paper,
            imagePoints: initialScale.imagePoints,
            sheetPointsIn: initialScale.sheetPointsIn,
            ...(initialScale.sheetIndex !== undefined && { sheetIndex: initialScale.sheetIndex, sheets: Math.max(...initialScale.sheetIndex) + 1 }),
          }
        : null;
  const twoSheets = (detection?.sheets ?? 1) >= 2;
  const printScale = detection === null ? 1 : initialScale?.kind === 'sheet' && find.status !== 'found' ? (initialScale.printScale ?? 1) : readPrintScale(detection.paper);
  const target: PlaneTarget = planeTargetFor(offsetIn);
  const engineTarget = ENGINE_TARGET[target];

  /** The ranked outline that is what the person measures, else the top one. */
  const defaultPick = (c: NonNullable<SnapInfo['candidates']>, t: typeof engineTarget) => Math.max(0, c.findIndex((x) => x.layer === TARGET_LAYER[t]));
  const applySnap = (s: SnappedQuad) => {
    const { quad, ...info } = s;
    setSnapInfo(info);
    if (needsOutlinePick(s)) {
      const index = defaultPick(s.candidates!, engineTarget);
      setPick({ index, by: 'auto' });
      setWindowQuad(roundQuad(index === 0 ? quad : s.candidates![index]!.quad, W, H));
    } else {
      setPick(null);
      setWindowQuad(roundQuad(quad, W, H));
    }
  };
  const runSnap = (q: Quad) => {
    if (!snapOn) return;
    const seq = ++snapSeq.current;
    setSnapping(true);
    void snap(q, engineTarget).then((s) => {
      if (seq !== snapSeq.current) return;
      setSnapping(false);
      if (s !== null) applySnap(s);
    });
  };

  // A new window on the sheet: once the photo is read and the sheet looked for, start from the engine's proposed
  // outline around the sheet (when it can propose one), else fit the starting corners to the frame nearby
  const seeded = useRef(initial !== null);
  const looked = find.status === 'found' || find.status === 'missing' || find.status === 'failed';
  const seed = () => {
    if (propose === null) {
      runSnap(windowQuad);
      return;
    }
    const seq = ++snapSeq.current;
    setSnapping(true);
    void propose(engineTarget).then((s) => {
      if (seq !== snapSeq.current) return;
      setSnapping(false);
      if (s !== null) applySnap(s);
      else runSnap(windowQuad);
    });
  };
  useEffect(() => {
    if (!sheetMode || !canSnap || !looked || seeded.current) return;
    seeded.current = true;
    seed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the pixels and the sheet are in
  }, [sheetMode, canSnap, looked]);

  const choose = (index: number, by: Pick_['by']) => {
    const c = snapInfo?.candidates?.[index];
    if (c === undefined) return;
    snapSeq.current += 1;
    setSnapping(false);
    setPick({ index, by });
    setWindowQuad(roundQuad(c.quad, W, H));
  };
  // Per-side confidence and corner noise belong to the engine's chosen outline (the first); another pick has neither
  const onChosen = snapInfo !== null && (pick === null || pick.index === 0);
  const cornerSigmaPx = onChosen ? snapInfo.cornerSigmaPx : undefined;

  const inches = Number.parseFloat(inchesText);
  const scale: WindowPhotoScale | null =
    method === 'reference'
      ? { kind: 'reference', reference, corners: paperQuad }
      : method === 'known-side'
        ? { kind: 'known-side', side, inches: Number.isFinite(inches) ? inches : 0 }
        : detection !== null
          ? {
              kind: 'sheet',
              paper: detection.paper,
              imagePoints: detection.imagePoints,
              sheetPointsIn: detection.sheetPointsIn,
              planeOffsetIn: offsetIn,
              ...(detection.sheetIndex !== undefined && { sheetIndex: detection.sheetIndex }),
              ...(printScale !== 1 && { printScale }),
            }
          : null;
  const input: PhotoWindowInput | null =
    scale === null
      ? null
      : {
          id: initial?.id ?? '',
          uploadId: upload.id,
          ...(label.trim() !== '' && { label: label.trim() }),
          ...(groupKey !== '' && groupKey !== initial?.id && { windowKey: groupKey }),
          corners: windowQuad,
          scale,
        };
  const unchanged = saved !== null && input !== null && sizingKey(saved) === sizingKey(input);

  // Each outline on offer, sized (for "A: 35 7/8 x 59 3/4"); the picked one is the measurement
  const offered = useMemo(
    () =>
      sheetMode && pick !== null && engine.cv !== null && detection !== null
        ? (snapInfo?.candidates ?? []).slice(0, PICK_MAX).map((c, i) => ({
            ...c,
            size: measureOnSheet(engine.cv!, upload, detection, c.quad, offsetIn, { cornerSigmaPx: i === 0 ? snapInfo?.cornerSigmaPx : undefined, printScale }),
          }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detection is derived from find / initial
    [sheetMode, pick, engine.cv, find, upload, snapInfo, offsetIn, printScale],
  );
  const pickedSize = pick !== null && offered.length > 1 ? (offered[pick.index]?.size ?? null) : undefined;
  const measurement: WindowPhotoMeasurement | null = useMemo(
    () =>
      pickedSize !== undefined
        ? pickedSize
        : sheetMode && engine.cv !== null && detection !== null
          ? measureOnSheet(engine.cv, upload, detection, windowQuad, offsetIn, { cornerSigmaPx, printScale })
          : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- detection is derived from find / initial
    [pickedSize, sheetMode, engine.cv, find, upload, windowQuad, offsetIn, cornerSigmaPx, printScale],
  );
  const size: { widthIn: number; heightIn: number } | null = unchanged
    ? { widthIn: saved.widthIn, heightIn: saved.heightIn }
    : sheetMode
      ? measurement
      : input !== null
        ? sizePhotoWindow(input, upload)
        : null;
  const uncertainty = unchanged ? (saved.uncertaintyIn ?? null) : (measurement?.uncertaintyIn ?? null);
  const uMax = uncertainty === null ? null : Math.max(uncertainty.width, uncertainty.height);
  const warnings = sheetMode && !unchanged ? (measurement?.warnings ?? []) : [];
  const distanceIn = unchanged ? (saved.distanceIn ?? null) : (measurement?.distanceIn ?? null);
  const viewAngleDeg = unchanged ? (saved.viewAngleDeg ?? null) : (measurement?.viewAngleDeg ?? null);
  const retake = sheetMode && size !== null && ((uMax !== null && uMax > RETAKE_UNCERTAINTY_IN) || warnings.length > 0);

  // The other photos of the same window, combined with this one
  const siblings = groupKey === '' ? [] : live.filter((w) => photoWindowKey(w) === groupKey && w.id !== initial?.id);
  const combined =
    sheetMode && engine.cv !== null && size !== null && siblings.length > 0
      ? engine.cv.combine([...siblings.map(asMeasurement), { ...asMeasurement({ ...size, uncertaintyIn: uncertainty, distanceIn, viewAngleDeg }) }])
      : null;

  const toPhoto = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = frameRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return [0, 0];
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const set = (which: Which, i: number, x: number, y: number) => {
    if (which === 'window') setWindowQuad((q) => moveQuadCorner(q, i, x, y, W, H));
    else setPaperQuad((q) => moveQuadCorner(q, i, x, y, W, H));
  };

  const onHandleDown = (which: Which, i: number) => (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    // The photo keeps the pointer for the whole drag: nothing under it scrolls or pans
    e.preventDefault();
    e.stopPropagation();
    try {
      frameRef.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // Still drags while the pointer stays over the photo.
    }
    // A snap still on its way is for corners the person is now moving: drop it
    snapSeq.current += 1;
    setSnapping(false);
    if (which === 'window') {
      setPick(null);
      setSnapInfo(null);
    }
    const q = which === 'window' ? windowQuad : paperQuad;
    const r = frameRef.current?.getBoundingClientRect();
    setDrag({ which, i, x: q[i]![0], y: q[i]![1], fw: r?.width ?? 0, fh: r?.height ?? 0 });
  };
  const onMove = (e: ReactPointerEvent) => {
    if (drag === null) return;
    e.preventDefault();
    const [x, y] = toPhoto(e);
    set(drag.which, drag.i, x, y);
    setDrag({ ...drag, x, y });
  };
  const onUp = () => {
    if (drag !== null && drag.which === 'window' && sheetMode) runSnap(windowQuad);
    setDrag(null);
  };

  const onKey = (which: Which, i: number) => (e: KeyboardEvent) => {
    const step = (Math.max(W, H) / 400) * (e.shiftKey ? 4 : 1);
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const move = d[e.key];
    if (move === undefined) return;
    e.preventDefault();
    const q = which === 'window' ? windowQuad : paperQuad;
    set(which, i, q[i]![0] + move[0], q[i]![1] + move[1]);
  };

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const points = (q: Quad) => q.map(([x, y]) => `${x},${y}`).join(' ');
  const handles = (which: Which, q: Quad) =>
    q.map(([x, y], i) => {
      const corner = copy.windowCorner[i as 0 | 1 | 2 | 3];
      return (
        <Button
          key={`${which}-${i}`}
          variant="ghost"
          className={styles.handle}
          data-which={which}
          data-corner={i}
          style={{ left: pct(x, W), top: pct(y, H) }}
          aria-label={which === 'window' ? copy.windowCornerLabel(corner) : copy.paperCornerLabel(corner)}
          onPointerDown={onHandleDown(which, i)}
          onKeyDown={onKey(which, i)}
        >
          <span className={styles.dot} aria-hidden="true" />
        </Button>
      );
    });

  // The window's four sides (top, right, bottom, left), each as sure as the snap was
  const lowSides = !onChosen ? [] : snapInfo.sideConfidence.flatMap((c, i) => (c < LOW_SIDE_CONFIDENCE ? [i] : []));
  const sideLines =
    sheetMode && onChosen
      ? windowQuad.map((a, i) => {
          const b = windowQuad[(i + 1) % 4]!;
          const sure = snapInfo.sideConfidence[i]!;
          return <line key={i} className={styles.edge} data-edge={i} data-low={sure < LOW_SIDE_CONFIDENCE ? 'true' : undefined} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} vectorEffect="non-scaling-stroke" />;
        })
      : null;
  const edgeFlags = lowSides.map((i) => {
    const a = windowQuad[i]!;
    const b = windowQuad[(i + 1) % 4]!;
    return (
      <span key={i} className={styles.edgeFlag} data-edge-flag={i} style={{ left: pct((a[0] + b[0]) / 2, W), top: pct((a[1] + b[1]) / 2, H) }}>
        {copy.checkEdge}
      </span>
    );
  });

  const frameWidth = drag?.fw ?? 0;
  const frameHeight = drag?.fh ?? 0;
  const loupe =
    drag !== null && frameWidth > 0 ? (
      <div
        className={styles.loupe}
        role="img"
        aria-label={copy.loupe}
        data-side={drag.x < W / 2 ? 'right' : 'left'}
        style={{
          backgroundImage: `url("${src}")`,
          backgroundSize: `${frameWidth * LOUPE_ZOOM}px ${frameHeight * LOUPE_ZOOM}px`,
          backgroundPosition: `${LOUPE_PX / 2 - (drag.x / W) * frameWidth * LOUPE_ZOOM}px ${LOUPE_PX / 2 - (drag.y / H) * frameHeight * LOUPE_ZOOM}px`,
        }}
      >
        <span className={styles.cross} data-which={drag.which} aria-hidden="true" />
      </div>
    ) : null;

  const save = () => {
    if (size === null || input === null) return;
    const id = input.id === '' ? newMarkId().replace(/^mark-/, 'photo-') : input.id;
    const final = { ...input, id };
    const local: LocalSheetSize | undefined =
      sheetMode && measurement !== null
        ? { key: sizingKey(final), widthIn: measurement.widthIn, heightIn: measurement.heightIn, uncertaintyIn: measurement.uncertaintyIn, distanceIn: measurement.distanceIn, viewAngleDeg: measurement.viewAngleDeg }
        : undefined;
    if (local !== undefined) onSave(final, local);
    else onSave(final);
  };

  const chooseTarget = (t: keyof typeof PLANE_TARGETS) => {
    setOffsetIn(PLANE_TARGETS[t]);
    setOffsetText(String(PLANE_TARGETS[t]));
    // An outline the screen picked follows what is measured; one the person tapped stays
    const c = snapInfo?.candidates;
    if (pick !== null && pick.by === 'auto' && c !== undefined) {
      const index = defaultPick(c, ENGINE_TARGET[t]);
      if (index !== pick.index) choose(index, 'auto');
    }
  };

  const sheetStatus = !sheetMode ? null : engine.status === 'loading' ? (
    <p className={styles.status} role="status" data-sheet="loading">
      {copy.engineLoading}
    </p>
  ) : engine.status === 'unavailable' ? (
    <Banner tone="warning">{copy.engineUnavailable}</Banner>
  ) : find.status === 'reading' || find.status === 'idle' ? (
    <p className={styles.status} role="status" data-sheet="reading">
      {copy.reading}
    </p>
  ) : find.status === 'missing' || find.status === 'failed' ? (
    <div className={styles.missing} role="alert" data-sheet="missing">
      <strong>{copy.sheetMissing}</strong>
      <ul className={styles.fixes}>
        {copy.sheetFixes.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <Button variant="ghost" className={styles.inline} onClick={onCancel}>
        {copy.retakePhoto}
      </Button>
    </div>
  ) : (
    <div className={styles.status} role="status" data-sheet="found">
      <span className={styles.found}>{copy.sheetFound}</span>
      {twoSheets ? (
        <span className={styles.found} data-two-sheets="">
          {copy.twoSheets}
        </span>
      ) : null}
      {distanceIn !== null && viewAngleDeg !== null ? <span data-quality="">{copy.quality(feet1(distanceIn), viewAngleDeg)}</span> : null}
      {warnings.length > 0 ? (
        <ul className={styles.warnings} data-warnings="">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  const showsSize = size !== null;
  const sizeText = !showsSize
    ? null
    : sheetMode || (unchanged && saved.scale.kind === 'sheet')
      ? copy.sizeExact(inchesFraction(size.widthIn), inchesFraction(size.heightIn))
      : copy.size(size.widthIn, size.heightIn);

  return (
    <div className={styles.measure} data-photo-measure="" data-method={method}>
      <div className={styles.methods} role="tablist" aria-label={copy.methodLabel}>
        {METHODS.map((m) => (
          <Button key={m} variant="ghost" role="tab" aria-selected={method === m} className={styles.method} data-selected={method === m ? 'true' : undefined} onClick={() => setMethod(m)}>
            {m === 'sheet' ? copy.methodSheet : m === 'reference' ? copy.methodReference : copy.methodKnownSide}
            {m === 'sheet' ? <span className={styles.recommended}>{copy.recommended}</span> : null}
          </Button>
        ))}
      </div>
      <p className={styles.hint}>{method === 'sheet' ? copy.sheetHint : method === 'reference' ? copy.referenceHint : copy.knownSideHint}</p>
      {sheetStatus}
      <div className={styles.area}>
        <div
          ref={frameRef}
          className={styles.frame}
          style={{ aspectRatio: `${W} / ${H}`, '--ratio': W / H } as CSSProperties}
          role="group"
          aria-label={copy.photoLabel}
          data-dragging={drag !== null ? 'true' : undefined}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => setDrag(null)}
        >
          <img className={styles.photo} src={src} alt="" draggable={false} />
          <svg className={styles.quads} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {method === 'reference' ? <polygon className={styles.paper} points={points(paperQuad)} vectorEffect="non-scaling-stroke" /> : null}
            {sheetMode && find.status === 'found' ? <polygon className={styles.sheet} data-sheet-outline="" points={points(find.detection.outline)} vectorEffect="non-scaling-stroke" /> : null}
            <polygon
              className={styles.window}
              data-snapping={snapping ? 'true' : undefined}
              style={pick !== null && offered.length > 1 ? { stroke: PICK_COLORS[pick.index] } : undefined}
              points={points(windowQuad)}
              vectorEffect="non-scaling-stroke"
            />
            {offered.map((c, i) =>
              i === pick?.index ? null : <polygon key={i} className={styles.candidate} data-candidate={i} style={{ stroke: PICK_COLORS[i] }} points={points(c.quad)} vectorEffect="non-scaling-stroke" />,
            )}
            {sideLines}
          </svg>
          {sheetMode && find.status === 'found' ? <span className="visually-hidden">{copy.sheetOutline}</span> : null}
          {edgeFlags}
          {offered.map((c, i) => {
            const [x, y] = c.quad[i % 4]!;
            return (
              <span key={i} className={styles.candidateTag} data-candidate-tag={i} data-corner={i % 4} data-picked={i === pick?.index ? 'true' : undefined} style={{ left: pct(x, W), top: pct(y, H), background: PICK_COLORS[i] }} aria-hidden="true">
                {copy.pickLetters[i]}
              </span>
            );
          })}
          {method === 'reference' ? handles('paper', paperQuad) : null}
          {handles('window', windowQuad)}
          {loupe}
        </div>
      </div>
      {offered.length > 1 ? (
        <fieldset className={styles.pick} data-outline-pick="">
          <legend className={styles.targetsLegend}>{copy.pickTitle}</legend>
          <p className={styles.practice}>{copy.pickHint}</p>
          {offered.map((c, i) => {
            const letter = copy.pickLetters[i]!;
            const sizeText = c.size === null ? copy.noSize : copy.sizeExact(inchesFraction(c.size.widthIn), inchesFraction(c.size.heightIn));
            const [cx, cy] = c.quad[3];
            const span = Math.max(W, H) * 0.07;
            return (
              <label key={i} className={styles.pickOption} data-candidate-option={i} data-checked={pick?.index === i ? 'true' : undefined}>
                <input type="radio" name="outline-pick" checked={pick?.index === i} onChange={() => choose(i, 'person')} aria-label={copy.pickOption(letter, sizeText, copy.layers[c.layer])} />
                <span className={styles.pickLetter} style={{ background: PICK_COLORS[i] }} aria-hidden="true">
                  {letter}
                </span>
                <span className={styles.targetText}>
                  <span>{sizeText}</span>
                  <span className={styles.targetHint}>
                    {copy.layers[c.layer]}
                    {c.layer === TARGET_LAYER[engineTarget] ? ` · ${copy.pickMatches}` : ''}
                  </span>
                </span>
                <span
                  className={styles.pickZoom}
                  role="img"
                  aria-label={copy.pickCorner(letter)}
                  style={{
                    backgroundImage: `url("${src}")`,
                    backgroundSize: `${(W / span) * PICK_ZOOM_PX}px ${(H / span) * PICK_ZOOM_PX}px`,
                    backgroundPosition: `${PICK_ZOOM_PX / 2 - (cx / span) * PICK_ZOOM_PX}px ${PICK_ZOOM_PX / 2 - (cy / span) * PICK_ZOOM_PX}px`,
                    borderColor: PICK_COLORS[i],
                  }}
                />
              </label>
            );
          })}
        </fieldset>
      ) : null}
      <div className={styles.controls}>
        {sheetMode ? (
          <>
            <div className={styles.snapRow}>
              <Checkbox label={copy.noSnap} checked={!snapOn} onChange={(next) => setSnapOn(!next)} />
              <span className={styles.snapState} role="status" data-snap={snapping ? 'snapping' : snapInfo !== null ? 'snapped' : 'none'}>
                {snapping ? copy.snapping : snapInfo !== null && snapOn ? copy.snapped : ''}
              </span>
            </div>
            {lowSides.length > 0 ? <Banner tone="warning">{copy.checkEdges(lowSides.map((i) => copy.sideNames[i]).join(', '))}</Banner> : null}
            <fieldset className={styles.targets}>
              <legend className={styles.targetsLegend}>{copy.targetLabel}</legend>
              {TARGETS.map((t) => (
                <label key={t} className={styles.target} data-checked={target === t ? 'true' : undefined}>
                  <input type="radio" name="plane-target" value={t} checked={target === t} onChange={() => chooseTarget(t)} />
                  <span className={styles.targetText}>
                    <span>{copy.targets[t].label}</span>
                    {copy.targets[t].hint !== '' ? <span className={styles.targetHint}>{copy.targets[t].hint}</span> : null}
                  </span>
                  <span className={styles.targetOffset} aria-hidden="true">
                    {PLANE_TARGETS[t] > 0 ? `+${inchesFraction(PLANE_TARGETS[t])}` : '0'}
                  </span>
                </label>
              ))}
              <p className={styles.practice}>{copy.practice}</p>
              <details className={styles.advanced} open={target === 'custom' ? true : undefined}>
                <summary>{copy.advanced}</summary>
                <Field
                  label={copy.offsetField}
                  type="number"
                  inputMode="decimal"
                  step={0.125}
                  min={-6}
                  max={6}
                  value={offsetText}
                  onChange={(e) => {
                    const text = e.currentTarget.value;
                    setOffsetText(text);
                    const v = Number.parseFloat(text);
                    if (Number.isFinite(v) && Math.abs(v) <= 6) setOffsetIn(v);
                  }}
                />
              </details>
            </fieldset>
          </>
        ) : method === 'reference' ? (
          <Select
            label={copy.paperSize}
            value={reference}
            options={PAPERS.map((p) => ({ value: p, label: copy.papers[p] }))}
            onChange={(value) => setReference(value as WindowPhotoReference)}
          />
        ) : (
          <div className={styles.knownSide}>
            <Select
              label={copy.side}
              value={side}
              options={[
                { value: 'width', label: copy.sides.width },
                { value: 'height', label: copy.sides.height },
              ]}
              onChange={(value) => setSide(value as 'width' | 'height')}
            />
            <Field label={copy.inches} type="number" inputMode="decimal" min={1} step={0.25} value={inchesText} onChange={(e) => setInchesText(e.currentTarget.value)} />
          </div>
        )}
        <div className={styles.size} role="status" data-live-size={size === null ? 'none' : 'live'} data-retake={retake ? 'true' : undefined}>
          <span className={styles.sizeLabel}>{copy.sizeLabel}</span>
          {sizeText !== null ? <strong className={styles.sizeValue}>{sizeText}</strong> : <span>{method === 'known-side' && !(inches > 0) ? copy.typeSide : copy.noSize}</span>}
          {sizeText !== null && uMax !== null && (sheetMode || unchanged) ? (
            <span className={styles.plusMinus} data-plus-minus="">
              {copy.plusMinus(plusMinusFraction(uMax))}
            </span>
          ) : null}
          {sizeText !== null ? <span className={styles.sizeSource}>{unchanged ? copy.fromServer : copy.live}</span> : null}
          {sizeText !== null && twoSheets && sheetMode ? <span className={styles.sizeNote} data-size-two-sheets="">{copy.twoSheetsSize}</span> : null}
          {sizeText !== null && sheetMode && printScale !== 1 ? (
            <span className={styles.sizeNote} data-size-print-scale="">
              {copy.printCheckApplied((printScale * 100).toFixed(1))}
            </span>
          ) : null}
          {combined !== null ? (
            <span className={styles.combined} data-combined="">
              <span className={styles.sizeLabel}>{copy.combinedLabel(siblings.length + 1)}</span>
              <strong>{copy.sizeExact(inchesFraction(combined.widthIn), inchesFraction(combined.heightIn))}</strong>
              <span>{copy.spread(plusMinusFraction(Math.max(combined.spreadIn.width, combined.spreadIn.height)))}</span>
            </span>
          ) : null}
        </div>
        {retake ? (
          <div className={styles.retake} role="alert" data-retake-prompt="">
            <strong>{copy.retake}</strong>
            {uMax !== null && uMax > RETAKE_UNCERTAINTY_IN ? <span>{copy.retakeWhy(plusMinusFraction(uMax))}</span> : null}
            <Button variant="ghost" className={styles.inline} onClick={onCancel}>
              {copy.retakePhoto}
            </Button>
          </div>
        ) : null}
        {unchanged && saved.quality === 'check' ? <Banner tone="warning">{copy.check}</Banner> : null}
        {groups.some((g) => g.key !== initial?.id) ? (
          <Select
            label={copy.whichWindow}
            value={groupKey}
            options={[{ value: '', label: copy.newWindow }, ...groups.map((g) => ({ value: g.key, label: g.name }))]}
            onChange={(value) => {
              setGroupKey(value);
              const g = groups.find((x) => x.key === value);
              if (g !== undefined && label.trim() === '') setLabel(g.name);
            }}
          />
        ) : null}
        <Field label={copy.label} placeholder={copy.labelPlaceholder} maxLength={60} value={label} onChange={(e) => setLabel(e.currentTarget.value)} />
        <div className={styles.actions}>
          <Button className={styles.save} disabled={size === null} onClick={save}>
            {copy.save}
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            {copy.cancel}
          </Button>
          {onDelete !== undefined ? (
            <Button variant="ghost" className={styles.delete} onClick={onDelete}>
              {copy.delete}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
