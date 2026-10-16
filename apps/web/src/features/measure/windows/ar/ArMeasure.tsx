import { Banner, Button } from '@roofline/ui';
import { sizeFromArPoints, type ArPoint, type ArQuad, type Quad, type WindowPhotoUpload } from '@roofline/shared';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { flushSync } from 'react-dom';
import { windowPhotos as copy } from '../../../../copy/measureWindows.ts';
import { inchesFraction, plusMinusFraction } from '../photoModel.ts';
import { asQuad, insetCorners, liveEdges } from './arMath.ts';
import { startArSession, type ArController, type ArDeps, type ArFinish, type ArSnapshot } from './arSession.ts';
import { xrSystem } from './xr.ts';
import styles from './ArMeasure.module.css';

/** What an AR measurement hands back: the frame's corners in AR space, and the one photo kept with them. */
export type ArResult = {
  pointsM: ArQuad;
  trackingLostCount: number;
  upload: WindowPhotoUpload;
  /** The four corners drawn into that photo (pixels), or the photo inset 15% when they could not be (`projected` false). */
  corners: Quad;
  projected: boolean;
};

type Stage = { at: 'intro'; error: string | null } | { at: 'running' } | { at: 'saving'; done: ArFinish } | { at: 'need-photo'; done: ArFinish; error: string | null } | { at: 'uploading'; done: ArFinish };

/** The overlay's buttons must not also count as an AR tap (WebXR DOM Overlays: beforexrselect). */
function useNoXrSelect<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener('beforexrselect', stop);
    return () => el.removeEventListener('beforexrselect', stop);
  }, []);
  return ref;
}

/**
 * What the person sees over the camera while measuring in AR (the WebXR dom-overlay): what to do now, the sides
 * measured so far, and Undo / Start over / Place corner / Finish / Exit. Pure: it draws a snapshot of the session.
 */
export function ArOverlay({
  snapshot,
  finishing = false,
  onPlace,
  onUndo,
  onRestart,
  onFinish,
  onExit,
}: {
  /** Null while the session is starting. */
  snapshot: ArSnapshot | null;
  finishing?: boolean;
  onPlace: () => void;
  onUndo: () => void;
  onRestart: () => void;
  onFinish: () => void;
  onExit: () => void;
}) {
  const controls = useNoXrSelect<HTMLDivElement>();
  const s = snapshot;
  const n = s?.points.length ?? 0;
  const lost = s?.phase === 'lost';
  const message =
    s === null || s.phase === 'starting'
      ? copy.arStarting
      : finishing
        ? copy.arSaving
        : lost
          ? copy.arLost
          : n === 4
            ? copy.arAllPlaced
            : s.phase === 'aiming'
              ? copy.arAimAt(copy.arCornerNames[n]!)
              : copy.arSearching;
  const edges = s === null ? [] : liveEdges(s.points, s.phase === 'aiming' ? s.aim : null);
  const quad = s === null ? null : asQuad(s.points);
  const size = quad === null ? null : sizeFromArPoints(quad);
  return (
    <div className={styles.overlayInner} data-ar-phase={s?.phase ?? 'starting'} data-ar-points={n}>
      <div className={styles.top}>
        <p className={styles.message} role={lost ? 'alert' : 'status'} aria-live={lost ? 'assertive' : 'polite'} data-ar-message="" data-lost={lost ? 'true' : undefined}>
          {message}
        </p>
        <p className={styles.tip}>{copy.arFrameTip}</p>
      </div>
      <div className={styles.aim} data-aim={s?.phase === 'aiming' && n < 4 ? 'on' : 'off'} aria-hidden="true">
        <span className={styles.aimDot} />
      </div>
      <div className={styles.readout}>
        <span className={styles.count}>{copy.arCornersPlaced(n)}</span>
        {edges.length > 0 ? (
          <ul className={styles.edges} data-ar-edges="">
            {edges.map((e, i) => (
              <li key={i} data-to-aim={e.toAim ? 'true' : undefined}>
                {copy.arEdge(copy.arEdgeNames[i]!, inchesFraction(e.inches))}
              </li>
            ))}
          </ul>
        ) : null}
        {size !== null ? (
          <p className={styles.size} data-ar-size="">
            <strong>{copy.sizeExact(inchesFraction(size.widthIn), inchesFraction(size.heightIn))}</strong>{' '}
            <span>{copy.plusMinus(plusMinusFraction(Math.max(size.uncertaintyIn.width, size.uncertaintyIn.height)))}</span>
          </p>
        ) : null}
        {size !== null && size.quality === 'check' ? (
          <p className={styles.warn} data-ar-check="">
            {copy.arCheckWhy(size.reasons.join('; '))}
          </p>
        ) : null}
        {s !== null && s.trackingLostCount > 0 ? <p className={styles.lostCount}>{copy.arLostTimes(s.trackingLostCount)}</p> : null}
      </div>
      <div ref={controls} className={styles.controls}>
        <Button variant="ghost" className={styles.control} disabled={n === 0 || finishing} onClick={onUndo}>
          {copy.arUndo}
        </Button>
        <Button variant="ghost" className={styles.control} disabled={n === 0 || finishing} onClick={onRestart}>
          {copy.arRestart}
        </Button>
        {n < 4 ? (
          <Button className={styles.primary} disabled={s?.phase !== 'aiming'} onClick={onPlace}>
            {copy.arPlace}
          </Button>
        ) : (
          <Button className={styles.primary} busy={finishing} onClick={onFinish}>
            {copy.arFinish}
          </Button>
        )}
        <Button variant="ghost" className={styles.control} disabled={finishing} onClick={onExit}>
          {copy.arExit}
        </Button>
      </div>
    </div>
  );
}

/**
 * Measuring one window in AR, from the intro (what to do, Start AR) through the session to the photo kept with it.
 * `photo` is the window's photo already taken (used, with the corners inset, when AR cannot keep a picture); without
 * one the person is asked for a normal photo. `uploadPhoto` sends a picture to the measurement.
 */
export function ArMeasure({
  photo,
  uploadPhoto,
  onResult,
  session: sessionDeps,
}: {
  photo: WindowPhotoUpload | null;
  uploadPhoto: (file: File) => Promise<WindowPhotoUpload>;
  onResult: (r: ArResult) => void;
  /** Overrides for the session (tests: WebGL and camera picture). */
  session?: Partial<Omit<ArDeps, 'xr' | 'overlay' | 'onChange'>>;
}) {
  const [stage, setStage] = useState<Stage>({ at: 'intro', error: null });
  const [snap, setSnap] = useState<ArSnapshot | null>(null);
  const [finishing, setFinishing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const controller = useRef<ArController | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Leaving the screen ends the session
  useEffect(
    () => () => {
      void controller.current?.exit();
    },
    [],
  );

  const deliver = async (done: ArFinish) => {
    if (done.capture !== null) {
      setStage({ at: 'saving', done });
      try {
        const file = new File([done.capture.blob], 'ar-window.jpg', { type: 'image/jpeg' });
        const upload = await uploadPhoto(file);
        // The server's displayed size may differ from the picture's (it should not): keep the corners on the photo
        const sx = upload.widthPx / done.capture.widthPx;
        const sy = upload.heightPx / done.capture.heightPx;
        const corners = done.capture.corners.map(([x, y]) => [Math.round(x * sx * 10) / 10, Math.round(y * sy * 10) / 10]) as Quad;
        onResult({ pointsM: done.pointsM, trackingLostCount: done.trackingLostCount, upload, corners, projected: true });
      } catch {
        // The picture did not go up: a normal photo (or the one already taken) still works
        if (photo !== null) onResult({ pointsM: done.pointsM, trackingLostCount: done.trackingLostCount, upload: photo, corners: insetCorners(photo.widthPx, photo.heightPx), projected: false });
        else setStage({ at: 'need-photo', done, error: copy.arUploadFailed });
      }
      return;
    }
    if (photo !== null) {
      onResult({ pointsM: done.pointsM, trackingLostCount: done.trackingLostCount, upload: photo, corners: insetCorners(photo.widthPx, photo.heightPx), projected: false });
      return;
    }
    setStage({ at: 'need-photo', done, error: null });
  };

  const start = () => {
    const xr = xrSystem();
    const overlay = overlayRef.current;
    if (xr === null || overlay === null) {
      setStage({ at: 'intro', error: copy.arFailed });
      return;
    }
    // The overlay must be on screen before the session asks for it (and still inside the tap's user activation)
    flushSync(() => {
      setSnap(null);
      setFinishing(false);
      setStage({ at: 'running' });
    });
    startArSession({
      ...sessionDeps,
      xr,
      overlay,
      onChange: setSnap,
      onEnd: () => {
        controller.current = null;
        sessionDeps?.onEnd?.();
        setStage((st) => (st.at === 'running' ? { at: 'intro', error: null } : st));
      },
    }).then(
      (c) => {
        controller.current = c;
      },
      () => setStage({ at: 'intro', error: copy.arFailed }),
    );
  };

  const finish = () => {
    const c = controller.current;
    if (c === null || finishing) return;
    setFinishing(true);
    void c.finish().then((done) => {
      setFinishing(false);
      if (done === null) return;
      void deliver(done);
    });
  };

  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (file === undefined || (stage.at !== 'need-photo' && stage.at !== 'uploading')) return;
    const done = stage.done;
    setStage({ at: 'uploading', done });
    uploadPhoto(file).then(
      (upload) => onResult({ pointsM: done.pointsM, trackingLostCount: done.trackingLostCount, upload, corners: insetCorners(upload.widthPx, upload.heightPx), projected: false }),
      () => setStage({ at: 'need-photo', done, error: copy.arUploadFailed }),
    );
  };

  const running = stage.at === 'running';
  return (
    <div className={styles.ar} data-ar-stage={stage.at}>
      {stage.at === 'intro' ? (
        <>
          <ul className={styles.guidance} data-ar-guidance="">
            {copy.arGuidance.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
          {stage.error !== null ? <Banner tone="warning">{stage.error}</Banner> : null}
          <Button className={styles.start} onClick={start}>
            {copy.arStart}
          </Button>
        </>
      ) : stage.at === 'saving' ? (
        <p role="status">{copy.arSaving}</p>
      ) : stage.at === 'need-photo' || stage.at === 'uploading' ? (
        <div className={styles.needPhoto} data-ar-need-photo="">
          <p>{copy.arNeedPhoto}</p>
          {stage.at === 'need-photo' && stage.error !== null ? <Banner tone="danger">{stage.error}</Banner> : null}
          <Button busy={stage.at === 'uploading'} onClick={() => cameraRef.current?.click()}>
            {stage.at === 'uploading' ? copy.arUploading : copy.arTakePhoto}
          </Button>
          <input ref={cameraRef} className="visually-hidden" type="file" accept="image/*" capture="environment" aria-label={copy.arTakePhotoLabel} onChange={onPhoto} />
        </div>
      ) : null}
      {/* The dom-overlay root: full screen over the camera while the session runs */}
      <div ref={overlayRef} className={styles.overlay} hidden={!running} role="dialog" aria-modal="true" aria-label={copy.arOverlay} data-ar-overlay="">
        {running ? (
          <ArOverlay
            snapshot={snap}
            finishing={finishing}
            onPlace={() => controller.current?.place()}
            onUndo={() => controller.current?.undo()}
            onRestart={() => controller.current?.restart()}
            onFinish={finish}
            onExit={() => void controller.current?.exit()}
          />
        ) : null}
      </div>
    </div>
  );
}

export default ArMeasure;

/** For tests and the visual check: a snapshot of a session. */
export function arSnapshot(over: Partial<ArSnapshot> & { points?: ArPoint[] } = {}): ArSnapshot {
  return { phase: 'aiming', points: [], aim: null, trackingLostCount: 0, anchors: true, cameraAccess: true, ...over };
}
