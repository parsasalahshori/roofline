import type { ArPoint, ArQuad, Quad } from '@roofline/shared';
import { projectToImage } from './arMath.ts';
import { createRenderer, readCameraImage, type ArRenderer, type CameraBinding } from './arRender.ts';
import type { XrAnchor, XrFrame, XrHitTestResult, XrHitTestSource, XrMatrix, XrReferenceSpace, XrSession, XrSystem, XrView } from './xr.ts';

/*
 * One AR measuring session (WebXR immersive-ar on an Android phone), the same flow as the iPhone app's:
 * - a viewer-space hit-test finds the wall; the FIRST vertical surface it hits is locked as the wall plane (a point and
 *   its normal), and from then on the reticle is where the phone's view ray meets that infinite plane (a frame's edges
 *   are exactly where AR's own surfaces stop, so raw hits at a corner jump to the glass or the room behind it). No
 *   corner can be placed before the wall is locked;
 * - a tap (the session's select event, or the overlay's Place button) starts sampling the corner: about a second of
 *   positions, collected only while the phone is held still (under 3 mm and 1 degree of pose change across 0.3 s),
 *   outliers dropped, averaged. The corner is anchored when the phone supports anchors (so it stays put as AR refines
 *   its map);
 * - tracking lost clears the corners and the wall (the world can shift when AR finds itself again): start the window
 *   again from the first corner;
 * - undo, start over, finish. On finish one camera picture is kept when the phone grants camera access, with the corners
 *   drawn into it through that frame's view and projection matrices; otherwise the caller asks for one ordinary photo.
 */

export type ArPhase = 'starting' | 'searching' | 'aiming' | 'sampling' | 'lost' | 'ended';

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
  /** AR has locked the wall plane the window is on (corners cannot be placed before). */
  wallLocked: boolean;
  /** While a corner is being sampled: how far along (0 to 1); otherwise null. */
  progress: number | null;
  /** The last corner could not be sampled because the phone kept moving: hold it still and tap again. */
  notice: 'hold-still' | null;
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
/** Asked for but not needed: a phone that refuses one of them still measures, minus that feature. (No depth sensing: nothing reads it.) */
export const OPTIONAL_FEATURES = ['dom-overlay', 'anchors', 'camera-access'];

/** The corner sampling: about a second of still frames, from a phone that moved under 3 mm and 1 degree across 0.3 s. */
export const SAMPLE_MS = 1000;
export const SAMPLE_TIMEOUT_MS = 4000;
export const MIN_SAMPLES = 8;
export const STILL_WINDOW_MS = 300;
export const STILL_MAX_MOVE_M = 0.003;
export const STILL_MAX_TURN_DEG = 1;
/** A sample further than this from the median is dropped (metres). */
const OUTLIER_M = 0.005;
/** A wall is vertical when its normal is within about 17 degrees of horizontal. */
const WALL_MAX_NORMAL_Y = 0.3;

type Placed = { at: ArPoint; anchor: XrAnchor | null; /** Where the average is from the anchor, once the anchor is known (follows AR's refined map). */ offset?: ArPoint };
type Plane = { point: ArPoint; normal: ArPoint };
type Sampling = { samples: ArPoint[]; stillMs: number; startedAt: number; lastT: number; hit: XrHitTestResult | null };
type PoseSample = { t: number; p: ArPoint; f: ArPoint };

const sub = (a: ArPoint, b: ArPoint): ArPoint => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: ArPoint, b: ArPoint) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: ArPoint) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: ArPoint): ArPoint | null => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Where a ray from `origin` along `dir` meets the plane; null when it is parallel, or the plane is behind the origin. */
export function intersectPlane(plane: Plane, origin: ArPoint, dir: ArPoint): ArPoint | null {
  const denom = dot(dir, plane.normal);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(sub(plane.point, origin), plane.normal) / denom;
  return t > 0 ? [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t] : null;
}

/** The corner from its samples: the ones within 5 mm of the per-axis median, averaged. Null with fewer than `MIN_SAMPLES`. */
export function averageSamples(samples: readonly ArPoint[]): ArPoint | null {
  if (samples.length < MIN_SAMPLES) return null;
  const med: ArPoint = [median(samples.map((p) => p[0])), median(samples.map((p) => p[1])), median(samples.map((p) => p[2]))];
  const kept = samples.filter((p) => len(sub(p, med)) <= OUTLIER_M);
  const use = kept.length >= MIN_SAMPLES / 2 ? kept : [med];
  return [0, 1, 2].map((k) => use.reduce((s, p) => s + p[k]!, 0) / use.length) as ArPoint;
}

/** Is the phone held still? The last `STILL_WINDOW_MS` of poses moved under 3 mm and turned under 1 degree. */
export function isStill(history: readonly PoseSample[], now: number): boolean {
  const w = history.filter((h) => now - h.t <= STILL_WINDOW_MS);
  const first = w[0];
  if (first === undefined || now - first.t < STILL_WINDOW_MS * 0.5) return false;
  const cosMax = Math.cos((STILL_MAX_TURN_DEG * Math.PI) / 180);
  return w.every((h) => len(sub(h.p, first.p)) <= STILL_MAX_MOVE_M && dot(h.f, first.f) >= cosMax);
}

/**
 * Opens the session. A phone that refuses an optional feature (Chrome does, over 'anchors' or 'camera-access' on some
 * phones) gets the session again without THAT feature, keeping the others; the refusal's own words name it when they can,
 * otherwise each optional feature is left out in turn.
 */
export async function requestArSession(xr: XrSystem, overlay: Element): Promise<XrSession> {
  const attempt = (optional: string[]) =>
    xr.requestSession('immersive-ar', {
      requiredFeatures: REQUIRED_FEATURES,
      optionalFeatures: optional,
      ...(optional.includes('dom-overlay') ? { domOverlay: { root: overlay } } : {}),
    });
  let optional = [...OPTIONAL_FEATURES];
  for (;;) {
    let error: unknown;
    try {
      return await attempt(optional);
    } catch (e) {
      error = e;
    }
    const said = String((error as { message?: unknown } | null)?.message ?? error);
    const named = optional.filter((f) => said.includes(f));
    if (named.length > 0) {
      optional = optional.filter((f) => !named.includes(f));
      continue;
    }
    // It does not say which: leave one out at a time, the first that works is the one it refused
    for (const f of optional) {
      try {
        return await attempt(optional.filter((x) => x !== f));
      } catch {
        // try the next
      }
    }
    throw error;
  }
}

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
  const session = await requestArSession(deps.xr, deps.overlay);
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
  let wall: Plane | null = null;
  let sampling: Sampling | null = null;
  let notice: 'hold-still' | null = null;
  let history: PoseSample[] = [];
  let phase: ArPhase = 'starting';
  let lost = 0;
  let tracked = false;
  let ended = false;
  let lastKey = '';
  let pendingCapture: ((frame: XrFrame, view: XrView | null) => void) | null = null;
  let rafHandle = 0;

  const progress = () => (sampling === null ? null : Math.min(1, sampling.stillMs / SAMPLE_MS));
  const snapshot = (): ArSnapshot => ({
    phase,
    points: placed.map((p) => p.at),
    aim,
    trackingLostCount: lost,
    anchors: has('anchors'),
    cameraAccess: has('camera-access') && (deps.captureCamera !== undefined || binding !== null),
    wallLocked: wall !== null,
    progress: progress(),
    notice,
  });
  // React hears about it when something it shows changes (the aim point to the nearest 2 mm), not 60 times a second
  const emit = (force = false) => {
    const mm = (v: number) => Math.round(v * 500);
    const pr = progress();
    const key = JSON.stringify([phase, lost, placed.map((p) => p.at.map(mm)), aim?.map(mm) ?? null, wall !== null, pr === null ? null : Math.round(pr * 10), notice]);
    if (!force && key === lastKey) return;
    lastKey = key;
    deps.onChange(snapshot());
  };

  /** A tap: start sampling the corner under the reticle (it is placed after about a second of holding still). */
  const place = (): boolean => {
    if (ended || placed.length >= 4 || aim === null || phase !== 'aiming' || wall === null || sampling !== null) return false;
    notice = null;
    sampling = { samples: [], stillMs: 0, startedAt: -1, lastT: -1, hit: lastHit };
    phase = 'sampling';
    emit(true);
    return true;
  };
  const addCorner = (at: ArPoint, hit: XrHitTestResult | null) => {
    const entry: Placed = { at, anchor: null };
    placed = [...placed, entry];
    if (has('anchors') && hit?.createAnchor) {
      hit.createAnchor().then(
        (a) => {
          if (placed.includes(entry)) entry.anchor = a;
          else a.delete?.();
        },
        () => undefined,
      );
    }
  };
  const dropAnchors = (list: Placed[]) => list.forEach((p) => p.anchor?.delete?.());
  const undo = () => {
    sampling = null;
    notice = null;
    if (placed.length === 0) return;
    dropAnchors(placed.slice(-1));
    placed = placed.slice(0, -1);
    emit(true);
  };
  const restart = () => {
    sampling = null;
    notice = null;
    dropAnchors(placed);
    placed = [];
    // The next window may be on another wall: find it again
    wall = null;
    emit(true);
  };

  const onFrame = (time: number, frame: XrFrame) => {
    if (ended) return;
    rafHandle = session.requestAnimationFrame(onFrame);
    const pose = frame.getViewerPose(local);
    const nowTracked = pose !== null && pose.emulatedPosition !== true;
    if (!nowTracked) {
      if (tracked && phase !== 'lost') {
        // The world can shift when AR finds itself again: what was placed cannot be trusted. Start the window again.
        lost += 1;
        dropAnchors(placed);
        placed = [];
        wall = null;
        sampling = null;
        notice = null;
        history = [];
      }
      if (tracked) phase = 'lost';
      else phase = 'searching';
      aim = null;
      reticle = null;
      lastHit = null;
    } else {
      if (phase === 'lost') phase = 'searching';
      tracked = true;
      const m = pose!.transform.matrix;
      const eye: ArPoint = [m[12]!, m[13]!, m[14]!];
      const forward = unit([-m[8]!, -m[9]!, -m[10]!]);
      if (forward !== null) {
        history.push({ t: time, p: eye, f: forward });
        history = history.filter((h) => time - h.t <= STILL_WINDOW_MS * 2);
      }
      const hits = source !== null ? frame.getHitTestResults(source) : [];
      const hitPose = hits.length > 0 ? hits[0]!.getPose(local) : null;
      lastHit = hitPose !== null ? hits[0]! : null;
      // The wall: the first vertical surface the hit-test finds, locked as a plane (its point and its normal)
      if (wall === null && hitPose !== null) {
        const hm = hitPose.transform.matrix;
        const n = unit([hm[4]!, hm[5]!, hm[6]!]);
        const at: ArPoint = [hitPose.transform.position.x, hitPose.transform.position.y, hitPose.transform.position.z];
        if (n !== null && Math.abs(n[1]) <= WALL_MAX_NORMAL_Y) {
          // Turned toward the phone
          wall = { point: at, normal: dot(n, sub(eye, at)) >= 0 ? n : [-n[0], -n[1], -n[2]] };
        }
      }
      // The reticle: where the view ray meets the wall plane (before the wall is locked: the raw hit, shown but not usable)
      if (wall !== null && forward !== null) {
        aim = intersectPlane(wall, eye, forward);
        const hm = hitPose?.transform.matrix;
        reticle = aim !== null && hm !== undefined ? [...Array.from(hm).slice(0, 12), aim[0], aim[1], aim[2], 1] : null;
      } else if (hitPose !== null) {
        const p = hitPose.transform.position;
        aim = [p.x, p.y, p.z];
        reticle = hitPose.transform.matrix;
      } else {
        aim = null;
        reticle = null;
      }
      if (sampling !== null) {
        const sm = sampling;
        if (sm.startedAt < 0) {
          sm.startedAt = time;
          sm.lastT = time;
        }
        if (isStill(history, time) && aim !== null) {
          sm.samples.push(aim);
          sm.stillMs += Math.min(100, Math.max(0, time - sm.lastT));
          sm.hit = lastHit ?? sm.hit;
        }
        sm.lastT = time;
        if (sm.stillMs >= SAMPLE_MS || time - sm.startedAt >= SAMPLE_TIMEOUT_MS) {
          const corner = averageSamples(sm.samples);
          sampling = null;
          if (corner !== null) addCorner(corner, sm.hit);
          else notice = 'hold-still';
        }
      }
      phase = sampling !== null ? 'sampling' : wall !== null && aim !== null ? 'aiming' : 'searching';
      // Anchored corners follow AR's refined map (the averaged point keeps its offset from its anchor)
      for (const p of placed) {
        if (p.anchor === null || (frame.trackedAnchors && !frame.trackedAnchors.has(p.anchor))) continue;
        const ap = frame.getPose(p.anchor.anchorSpace, local);
        if (ap === null) continue;
        const a: ArPoint = [ap.transform.position.x, ap.transform.position.y, ap.transform.position.z];
        if (p.offset === undefined) p.offset = sub(p.at, a);
        p.at = [a[0] + p.offset[0], a[1] + p.offset[1], a[2] + p.offset[2]];
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
