import type { ArPoint, ArQuad, Quad } from '@roofline/shared';
import { projectToImage } from './arMath.ts';
import { createRenderer, readCameraImage, type ArRenderer, type CameraBinding } from './arRender.ts';
import type { XrAnchor, XrFrame, XrHitTestResult, XrHitTestSource, XrMatrix, XrReferenceSpace, XrSession, XrSystem, XrView } from './xr.ts';

/*
 * One AR measuring session (WebXR immersive-ar on an Android phone): a viewer-space hit-test puts a reticle on the
 * wall or frame; each tap (the session's select event, or the overlay's Place button) drops the next corner where the
 * reticle is, anchored when the phone supports anchors (so the corner stays put as AR refines its map). Undo, start
 * over, finish. On finish one camera picture is kept when the phone grants camera access, with the corners drawn into
 * it through that frame's view and projection matrices; otherwise the caller asks for one ordinary photo.
 */

export type ArPhase = 'starting' | 'searching' | 'aiming' | 'lost' | 'ended';

export type ArSnapshot = {
  phase: ArPhase;
  /** Corners placed so far (TL, TR, BR, BL order), metres, AR world space. */
  points: ArPoint[];
  /** Where the reticle is, or null when no surface is found. */
  aim: ArPoint | null;
  /** Times AR lost the wall during this session. */
  trackingLostCount: number;
  /** The phone keeps the corners on anchors. */
  anchors: boolean;
  /** The phone granted camera access: the picture is kept on finish. */
  cameraAccess: boolean;
};

export type ArCapture = { blob: Blob; widthPx: number; heightPx: number; corners: Quad };
export type ArFinish = { pointsM: ArQuad; trackingLostCount: number; capture: ArCapture | null };

export type ArController = {
  place: () => boolean;
  undo: () => void;
  restart: () => void;
  finish: () => Promise<ArFinish | null>;
  exit: () => Promise<void>;
  snapshot: () => ArSnapshot;
};

export type ArDeps = {
  xr: XrSystem;
  /** The element shown over the camera (dom-overlay root). */
  overlay: Element;
  onChange: (s: ArSnapshot) => void;
  /** The session ended (by finish, exit, or the system's back button). */
  onEnd?: () => void;
  /** The WebGL context the lines are drawn with (null: no drawing, the overlay still works). */
  createGl?: () => WebGLRenderingContext | null;
  /** The XR layer for that context (default: new XRWebGLLayer). */
  createLayer?: (session: XrSession, gl: WebGLRenderingContext) => unknown;
  /** The camera picture of this frame as a JPEG with its size (default: XRWebGLBinding.getCameraImage + read back). */
  captureCamera?: (view: XrView, frame: XrFrame) => Promise<{ blob: Blob; widthPx: number; heightPx: number } | null>;
  /** How long finish waits for a frame to take the picture from, ms. */
  captureTimeoutMs?: number;
};

export const REQUIRED_FEATURES = ['hit-test'];
export const OPTIONAL_FEATURES = ['dom-overlay', 'anchors', 'camera-access', 'depth-sensing'];
/** Chrome refuses 'depth-sensing' without its preferences (the depth is not used yet; asked so later snapping can). */
const DEPTH_SENSING = { usagePreference: ['cpu-optimized', 'gpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] };

type Placed = { at: ArPoint; anchor: XrAnchor | null };

const g = globalThis as unknown as {
  XRWebGLLayer?: new (session: XrSession, gl: WebGLRenderingContext) => unknown;
  XRWebGLBinding?: new (session: XrSession, gl: WebGLRenderingContext) => CameraBinding;
};

function defaultGl(): WebGLRenderingContext | null {
  try {
    const canvas = document.createElement('canvas');
    return (canvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: true }) as WebGLRenderingContext | null) ?? null;
  } catch {
    return null;
  }
}

const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> => new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92));

export async function startArSession(deps: ArDeps): Promise<ArController> {
  const init = { requiredFeatures: REQUIRED_FEATURES, optionalFeatures: OPTIONAL_FEATURES, domOverlay: { root: deps.overlay }, depthSensing: DEPTH_SENSING };
  let session: XrSession;
  try {
    session = await deps.xr.requestSession('immersive-ar', init);
  } catch {
    // Some phones refuse a session over one optional feature: try again with just the overlay
    session = await deps.xr.requestSession('immersive-ar', { requiredFeatures: REQUIRED_FEATURES, optionalFeatures: ['dom-overlay'], domOverlay: { root: deps.overlay } });
  }
  const features = session.enabledFeatures;
  const has = (f: string) => features === undefined || features.includes(f);

  const gl = (deps.createGl ?? defaultGl)();
  let renderer: ArRenderer | null = null;
  let binding: CameraBinding | null = null;
  if (gl !== null) {
    try {
      const layer = deps.createLayer ? deps.createLayer(session, gl) : g.XRWebGLLayer ? new g.XRWebGLLayer(session, gl) : null;
      if (layer !== null) await session.updateRenderState({ baseLayer: layer });
      renderer = createRenderer(gl);
      if (has('camera-access') && g.XRWebGLBinding) binding = new g.XRWebGLBinding(session, gl);
    } catch {
      renderer = null;
    }
  }
  const capture =
    deps.captureCamera ??
    (async (view: XrView) => {
      if (gl === null || binding === null || !view.camera) return null;
      const canvas = readCameraImage(gl, binding, view.camera, session.renderState?.baseLayer?.framebuffer ?? null);
      if (canvas === null) return null;
      const blob = await canvasBlob(canvas);
      return blob === null ? null : { blob, widthPx: canvas.width, heightPx: canvas.height };
    });

  const local: XrReferenceSpace = await session.requestReferenceSpace('local');
  const viewer: XrReferenceSpace = await session.requestReferenceSpace('viewer');
  let source: XrHitTestSource | null = null;
  try {
    source = (await session.requestHitTestSource?.({ space: viewer })) ?? null;
  } catch {
    source = null;
  }

  let placed: Placed[] = [];
  let aim: ArPoint | null = null;
  let reticle: XrMatrix | null = null;
  let lastHit: XrHitTestResult | null = null;
  let phase: ArPhase = 'starting';
  let lost = 0;
  let tracked = false;
  let ended = false;
  let lastKey = '';
  let pendingCapture: ((frame: XrFrame, view: XrView | null) => void) | null = null;
  let rafHandle = 0;

  const snapshot = (): ArSnapshot => ({
    phase,
    points: placed.map((p) => p.at),
    aim,
    trackingLostCount: lost,
    anchors: has('anchors'),
    cameraAccess: has('camera-access') && (deps.captureCamera !== undefined || binding !== null),
  });
  // React hears about it when something it shows changes (the aim point to the nearest 2 mm), not 60 times a second
  const emit = (force = false) => {
    const mm = (v: number) => Math.round(v * 500);
    const key = JSON.stringify([phase, lost, placed.map((p) => p.at.map(mm)), aim?.map(mm) ?? null]);
    if (!force && key === lastKey) return;
    lastKey = key;
    deps.onChange(snapshot());
  };

  const place = (): boolean => {
    if (ended || placed.length >= 4 || aim === null || phase !== 'aiming') return false;
    const entry: Placed = { at: [aim[0], aim[1], aim[2]], anchor: null };
    placed = [...placed, entry];
    const hit = lastHit;
    if (has('anchors') && hit?.createAnchor) {
      hit.createAnchor().then(
        (a) => {
          if (placed.includes(entry)) entry.anchor = a;
          else a.delete?.();
        },
        () => undefined,
      );
    }
    emit(true);
    return true;
  };
  const dropAnchors = (list: Placed[]) => list.forEach((p) => p.anchor?.delete?.());
  const undo = () => {
    if (placed.length === 0) return;
    dropAnchors(placed.slice(-1));
    placed = placed.slice(0, -1);
    emit(true);
  };
  const restart = () => {
    dropAnchors(placed);
    placed = [];
    emit(true);
  };

  const onFrame = (_time: number, frame: XrFrame) => {
    if (ended) return;
    rafHandle = session.requestAnimationFrame(onFrame);
    const pose = frame.getViewerPose(local);
    const nowTracked = pose !== null && pose.emulatedPosition !== true;
    if (!nowTracked) {
      if (tracked && phase !== 'lost') lost += 1;
      if (tracked) phase = 'lost';
      else phase = 'searching';
      aim = null;
      reticle = null;
      lastHit = null;
    } else {
      tracked = true;
      const hits = source !== null ? frame.getHitTestResults(source) : [];
      const hitPose = hits.length > 0 ? hits[0]!.getPose(local) : null;
      if (hitPose !== null) {
        const p = hitPose.transform.position;
        aim = [p.x, p.y, p.z];
        reticle = hitPose.transform.matrix;
        lastHit = hits[0]!;
        phase = 'aiming';
      } else {
        aim = null;
        reticle = null;
        lastHit = null;
        phase = 'searching';
      }
      // Anchored corners follow AR's refined map
      for (const p of placed) {
        if (p.anchor === null || (frame.trackedAnchors && !frame.trackedAnchors.has(p.anchor))) continue;
        const ap = frame.getPose(p.anchor.anchorSpace, local);
        if (ap !== null) p.at = [ap.transform.position.x, ap.transform.position.y, ap.transform.position.z];
      }
    }
    const view = pose?.views[0] ?? null;
    if (pendingCapture !== null) {
      const take = pendingCapture;
      pendingCapture = null;
      take(frame, nowTracked ? view : null);
    }
    if (renderer !== null && pose !== null) {
      const layer = session.renderState?.baseLayer ?? null;
      const views = pose.views.flatMap((v) => {
        const viewport = layer?.getViewport(v) ?? null;
        return viewport === null ? [] : [{ viewport, projectionMatrix: v.projectionMatrix, viewMatrix: v.transform.inverse.matrix }];
      });
      renderer.draw(layer?.framebuffer ?? null, views, { points: placed.map((p) => p.at), aim, reticle });
    }
    emit();
  };

  const onSelect = () => {
    place();
  };
  const onEnd = () => {
    if (ended) return;
    ended = true;
    phase = 'ended';
    session.cancelAnimationFrame?.(rafHandle);
    source?.cancel?.();
    renderer?.dispose();
    pendingCapture?.(null as unknown as XrFrame, null);
    emit(true);
    deps.onEnd?.();
  };
  session.addEventListener('select', onSelect);
  session.addEventListener('end', onEnd);
  rafHandle = session.requestAnimationFrame(onFrame);
  emit(true);

  const exit = async () => {
    if (ended) return;
    try {
      await session.end();
    } finally {
      onEnd();
    }
  };

  const finish = async (): Promise<ArFinish | null> => {
    if (placed.length !== 4 || ended) return null;
    const points = placed.map((p) => p.at) as ArQuad;
    const result: ArCapture | null = await new Promise<ArCapture | null>((resolve) => {
      const timer = setTimeout(() => {
        pendingCapture = null;
        resolve(null);
      }, deps.captureTimeoutMs ?? 1500);
      pendingCapture = (frame, view) => {
        clearTimeout(timer);
        if (view === null || frame === null) return resolve(null);
        const corners = view.camera ? projectToImage(points, view.transform.inverse.matrix, view.projectionMatrix, view.camera.width, view.camera.height) : null;
        // The picture must be read inside this frame's callback: start it now, finish after
        const shot = has('camera-access') && corners !== null ? capture(view, frame) : Promise.resolve(null);
        shot.then(
          (got) => {
            if (got === null || corners === null) return resolve(null);
            // The picture may come back at another size than the camera reported: scale the corners to it
            const sx = got.widthPx / view.camera!.width;
            const sy = got.heightPx / view.camera!.height;
            resolve({ ...got, corners: corners.map(([x, y]) => [Math.round(x * sx * 10) / 10, Math.round(y * sy * 10) / 10]) as Quad });
          },
          () => resolve(null),
        );
      };
    });
    const out: ArFinish = { pointsM: points, trackingLostCount: lost, capture: result };
    await exit();
    return out;
  };

  return { place, undo, restart, finish, exit, snapshot };
}
