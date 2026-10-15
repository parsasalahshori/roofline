import { Banner, Button, Field, Select } from '@roofline/ui';
import { WINDOW_PHOTO_REFERENCES, type PhotoWindow, type PhotoWindowInput, type Quad, type WindowPhotoReference, type WindowPhotoUpload } from '@roofline/shared';
import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { windowPhotos as copy } from '../../../copy/measureWindows.ts';
import { newMarkId } from './model.ts';
import { seedPaperQuad, seedWindowQuad, sizePhotoWindow } from './photoModel.ts';
import styles from './PhotoMeasure.module.css';

type Method = 'reference' | 'known-side';
type Which = 'window' | 'paper';
type Drag = { which: Which; i: number; x: number; y: number; fw: number; fh: number };

const LOUPE_PX = 112;
const LOUPE_ZOOM = 3;
const PAPERS = Object.keys(WINDOW_PHOTO_REFERENCES) as WindowPhotoReference[];

/** One corner of a quad moved to (x, y), kept on the photo. */
export function moveQuadCorner(q: Quad, i: number, x: number, y: number, w: number, h: number): Quad {
  return q.map((p, j) => (j === i ? [Math.round(Math.min(w, Math.max(0, x)) * 10) / 10, Math.round(Math.min(h, Math.max(0, y)) * 10) / 10] : p)) as Quad;
}

/**
 * Sizing one photographed window, full screen on a phone: the photo with the window's four corners (accent) and,
 * with "Paper on the glass", the paper's four (blue); a loupe magnifies the corner being dragged. The size shows live
 * (the same math the server runs); Save hands the window back to be saved.
 */
export function PhotoMeasure({
  upload,
  src,
  initial,
  saved,
  onSave,
  onCancel,
  onDelete,
}: {
  upload: WindowPhotoUpload;
  src: string;
  /** The window being edited, or null for a new one on this photo. */
  initial: PhotoWindowInput | null;
  /** The server's sized window for `initial`, when it has one. */
  saved: PhotoWindow | null;
  onSave: (input: PhotoWindowInput) => void;
  onCancel: () => void;
  onDelete?: (() => void) | undefined;
}) {
  const W = upload.widthPx;
  const H = upload.heightPx;
  const [method, setMethod] = useState<Method>(initial?.scale.kind === 'known-side' ? 'known-side' : 'reference');
  const [windowQuad, setWindowQuad] = useState<Quad>(initial?.corners ?? seedWindowQuad(W, H));
  const [reference, setReference] = useState<WindowPhotoReference>(initial?.scale.kind === 'reference' ? initial.scale.reference : 'letter');
  const [paperQuad, setPaperQuad] = useState<Quad>(
    initial?.scale.kind === 'reference' ? initial.scale.corners : seedPaperQuad(W, H, WINDOW_PHOTO_REFERENCES.letter.widthIn / WINDOW_PHOTO_REFERENCES.letter.heightIn),
  );
  const [side, setSide] = useState<'width' | 'height'>(initial?.scale.kind === 'known-side' ? initial.scale.side : 'width');
  const [inchesText, setInchesText] = useState(initial?.scale.kind === 'known-side' ? String(initial.scale.inches) : '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [drag, setDrag] = useState<Drag | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const inches = Number.parseFloat(inchesText);
  const input: PhotoWindowInput = {
    id: initial?.id ?? '',
    uploadId: upload.id,
    ...(label.trim() !== '' && { label: label.trim() }),
    corners: windowQuad,
    scale: method === 'reference' ? { kind: 'reference', reference, corners: paperQuad } : { kind: 'known-side', side, inches: Number.isFinite(inches) ? inches : 0 },
  };
  const unchanged = saved !== null && JSON.stringify([saved.corners, saved.scale]) === JSON.stringify([input.corners, input.scale]);
  const size = unchanged ? { widthIn: saved.widthIn, heightIn: saved.heightIn } : sizePhotoWindow(input, upload);

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
  const onUp = () => setDrag(null);

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
    if (size === null) return;
    onSave({ ...input, id: input.id === '' ? newMarkId().replace(/^mark-/, 'photo-') : input.id });
  };

  return (
    <div className={styles.measure} data-photo-measure="">
      <div className={styles.methods} role="tablist" aria-label={copy.methodLabel}>
        {(['reference', 'known-side'] as const).map((m) => (
          <Button key={m} variant="ghost" role="tab" aria-selected={method === m} className={styles.method} data-selected={method === m ? 'true' : undefined} onClick={() => setMethod(m)}>
            {m === 'reference' ? copy.methodReference : copy.methodKnownSide}
            {m === 'reference' ? <span className={styles.recommended}>{copy.recommended}</span> : null}
          </Button>
        ))}
      </div>
      <p className={styles.hint}>{method === 'reference' ? copy.referenceHint : copy.knownSideHint}</p>
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
          onPointerCancel={onUp}
        >
          <img className={styles.photo} src={src} alt="" draggable={false} />
          <svg className={styles.quads} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {method === 'reference' ? <polygon className={styles.paper} points={points(paperQuad)} vectorEffect="non-scaling-stroke" /> : null}
            <polygon className={styles.window} points={points(windowQuad)} vectorEffect="non-scaling-stroke" />
          </svg>
          {method === 'reference' ? handles('paper', paperQuad) : null}
          {handles('window', windowQuad)}
          {loupe}
        </div>
      </div>
      <div className={styles.controls}>
        {method === 'reference' ? (
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
        <div className={styles.size} role="status" data-live-size={size === null ? 'none' : 'live'}>
          <span className={styles.sizeLabel}>{copy.sizeLabel}</span>
          {size !== null ? <strong className={styles.sizeValue}>{copy.size(size.widthIn, size.heightIn)}</strong> : <span>{method === 'known-side' && !(inches > 0) ? copy.typeSide : copy.noSize}</span>}
          {size !== null ? <span className={styles.sizeSource}>{unchanged ? copy.fromServer : copy.live}</span> : null}
        </div>
        {unchanged && saved.quality === 'check' ? <Banner tone="warning">{copy.check}</Banner> : null}
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
