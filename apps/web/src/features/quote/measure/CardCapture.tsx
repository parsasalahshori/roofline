import { Banner, Button } from '@roofline/ui';
import type { Quad } from '@roofline/shared';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { homeownerMeasure as copy } from '../../../copy/homeownerMeasure.ts';
import type { Draft } from './flow.ts';
import { HomeownerApiError, type Uploaded } from './api.ts';
import { preparePhoto } from './photo.ts';
import { TapPhoto, type Pt } from './TapPhoto.tsx';
import styles from './MeasureFlow.module.css';

/** A bank card: any ID-1 card (credit, debit, driver license) is 85.6 x 53.98 mm. */
export const CARD_MM = { widthMm: 85.6, heightMm: 53.98 } as const;

type Photo = { src: string; up: Uploaded };

/** The card is a small part of the photo, so its corners are tapped zoomed in on it. */
const START_ZOOM = 5;
const MIN_ZOOM = 2;
const MAX_ZOOM = 12;

/**
 * Measuring a window with a bank card lying flat on the glass: one photo (taken here with the camera), then the four
 * corners of the card, then the four corners of the window frame. Hands back the same fields the iPhone app sends
 * (scale kind 'card'). Quote-grade: the company measures again at the visit.
 */
export function CardCapture({
  windowId,
  upload,
  maxPhotoBytes,
  onDone,
}: {
  windowId: string;
  /** Sends the photo to the request. */
  upload: (photo: Blob) => Promise<Uploaded>;
  maxPhotoBytes: number;
  onDone: (draft: Draft) => void;
}) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<Pt | null>(null);
  const [zoom, setZoom] = useState(START_ZOOM);
  const [cardPts, setCardPts] = useState<Pt[]>([]);
  const [framePts, setFramePts] = useState<Pt[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const url = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (url.current !== null) URL.revokeObjectURL(url.current);
    },
    [],
  );

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await preparePhoto(file, maxPhotoBytes);
      if (blob === null) {
        setError(copy.cardTooBig);
        return;
      }
      const up = await upload(blob);
      if (url.current !== null) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      setPhoto({ src: url.current, up });
      setFocus(null);
      setCardPts([]);
      setFramePts([]);
    } catch (err) {
      setError(err instanceof HomeownerApiError && err.status !== 0 && err.status < 500 ? err.message : copy.cardUploadFailed);
    } finally {
      setBusy(false);
    }
  };

  const phase: 'photo' | 'find' | 'card' | 'frame' | 'ready' = photo === null ? 'photo' : focus === null ? 'find' : cardPts.length < 4 ? 'card' : framePts.length < 4 ? 'frame' : 'ready';
  const names = copy.cardCornerNames;
  const undo = () => {
    if (framePts.length > 0) setFramePts(framePts.slice(0, -1));
    else if (cardPts.length > 0) setCardPts(cardPts.slice(0, -1));
    else setFocus(null);
  };
  const finish = () => {
    if (photo === null || phase !== 'ready') return;
    onDone({
      id: windowId,
      scale: { kind: 'card', cardCorners: cardPts as Quad, card: { ...CARD_MM } },
      uploadId: photo.up.id,
      corners: framePts as Quad,
    });
  };

  const camera = (
    <>
      <Button size="lg" busy={busy} onClick={() => input.current?.click()}>
        {photo === null ? copy.cardTake : copy.cardRetake}
      </Button>
      <input ref={input} className="visually-hidden" type="file" accept="image/*" capture="environment" aria-label={copy.cardPhotoLabel} onChange={(e) => void onFile(e)} data-card-photo="" />
    </>
  );

  if (photo === null) {
    return (
      <div className={styles.stack} data-card-phase="photo">
        <p className={styles.text}>{copy.cardIntro}</p>
        {busy ? <p role="status">{copy.cardUploading}</p> : null}
        {error !== null ? <Banner tone="danger">{error}</Banner> : null}
        {camera}
      </div>
    );
  }
  const cornerName = names[(phase === 'card' ? cardPts.length : framePts.length) % 4]!;
  const editing = phase === 'card' ? cardPts : framePts;
  const prompt = phase === 'find' ? copy.cardFind : phase === 'card' ? copy.cardTapCard(cornerName) : phase === 'frame' ? copy.cardTapFrame(cornerName) : copy.cardPlaced(4, 4);
  return (
    <div className={styles.stack} data-card-phase={phase}>
      <p className={styles.stepLine}>{phase === 'find' || phase === 'card' ? copy.cardStepCard : copy.cardStepFrame}</p>
      <p className={styles.prompt} role="status" aria-live="polite" data-card-prompt="">
        {prompt}
      </p>
      <TapPhoto
        key={phase === 'find' ? 'find' : phase === 'card' ? 'card' : 'frame'}
        src={photo.src}
        width={photo.up.widthPx}
        height={photo.up.heightPx}
        points={editing}
        onChange={phase === 'card' ? setCardPts : setFramePts}
        kind={phase === 'find' || phase === 'card' ? 'card' : 'frame'}
        view={phase === 'card' && focus !== null ? { zoom, cx: focus[0], cy: focus[1] } : null}
        onPick={phase === 'find' ? setFocus : undefined}
        locked={phase === 'frame' || phase === 'ready' ? cardPts : []}
        cornerLabel={(i) => copy.cardCornerLabel(phase === 'card' || phase === 'find' ? copy.cardCardWord : copy.cardWindowWord, names[i]!)}
        areaLabel={copy.cardPhotoArea}
      />
      {phase === 'card' ? (
        <div className={styles.zoomRow}>
          <Button variant="ghost" className={styles.ctl} disabled={zoom <= MIN_ZOOM} onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5))}>
            {copy.cardZoomOut}
          </Button>
          <Button variant="ghost" className={styles.ctl} disabled={zoom >= MAX_ZOOM} onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))}>
            {copy.cardZoomIn}
          </Button>
        </div>
      ) : null}
      {phase !== 'find' ? <p className={styles.small}>{copy.cardPlaced(editing.length, 4)}</p> : null}
      {error !== null ? <Banner tone="danger">{error}</Banner> : null}
      <div className={styles.row}>
        <Button variant="ghost" className={styles.ctl} disabled={focus === null} onClick={undo}>
          {copy.cardUndo}
        </Button>
        <Button
          variant="ghost"
          className={styles.ctl}
          onClick={() => {
            setFocus(null);
            setCardPts([]);
            setFramePts([]);
          }}
        >
          {copy.cardRestart}
        </Button>
      </div>
      {phase === 'ready' ? (
        <Button size="lg" onClick={finish}>
          {copy.cardUse}
        </Button>
      ) : null}
      {camera}
    </div>
  );
}
