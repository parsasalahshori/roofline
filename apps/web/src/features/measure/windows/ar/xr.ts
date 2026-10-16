/*
 * The small part of WebXR (immersive-ar, hit-test, anchors, dom-overlay, camera-access) this feature uses, typed
 * here instead of adding @types/webxr: the shapes follow the W3C WebXR Device API, Hit Test, Anchors, DOM Overlays and
 * Raw Camera Access specs. Structural, so the tests' fake navigator.xr fits them too.
 */

export type XrMatrix = Float32Array | number[];
export type XrRigidTransform = { position: { x: number; y: number; z: number }; matrix: XrMatrix; inverse: { matrix: XrMatrix } };
export type XrPose = { transform: XrRigidTransform; emulatedPosition?: boolean };
export type XrCamera = { width: number; height: number };
export type XrView = { eye?: string; projectionMatrix: XrMatrix; transform: XrRigidTransform; camera?: XrCamera | null };
export type XrViewerPose = XrPose & { views: readonly XrView[] };
export type XrSpace = object;
export type XrReferenceSpace = XrSpace;
export type XrAnchor = { anchorSpace: XrSpace; delete?: () => void };
export type XrHitTestResult = { getPose: (base: XrSpace) => XrPose | null; createAnchor?: () => Promise<XrAnchor> };
export type XrHitTestSource = { cancel?: () => void };
export type XrFrame = {
  session: XrSession;
  getViewerPose: (space: XrReferenceSpace) => XrViewerPose | null;
  getHitTestResults: (source: XrHitTestSource) => readonly XrHitTestResult[];
  getPose: (space: XrSpace, base: XrSpace) => XrPose | null;
  trackedAnchors?: { has: (a: XrAnchor) => boolean };
};
export type XrSession = {
  requestReferenceSpace: (type: 'viewer' | 'local' | 'local-floor') => Promise<XrReferenceSpace>;
  requestHitTestSource?: (options: { space: XrSpace }) => Promise<XrHitTestSource> | undefined;
  requestAnimationFrame: (cb: (time: number, frame: XrFrame) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  updateRenderState: (state: { baseLayer?: unknown }) => void | Promise<void>;
  renderState?: { baseLayer?: { framebuffer: WebGLFramebuffer | null; framebufferWidth: number; framebufferHeight: number; getViewport: (view: XrView) => { x: number; y: number; width: number; height: number } | null } | null };
  addEventListener: (type: 'select' | 'end', cb: () => void) => void;
  removeEventListener?: (type: 'select' | 'end', cb: () => void) => void;
  end: () => Promise<void>;
  enabledFeatures?: readonly string[];
  domOverlayState?: { type: string } | null;
};
export type XrSystem = {
  isSessionSupported: (mode: 'immersive-ar') => Promise<boolean>;
  requestSession: (
    mode: 'immersive-ar',
    init: { requiredFeatures: string[]; optionalFeatures: string[]; domOverlay?: { root: Element } },
  ) => Promise<XrSession>;
};

/** The browser's WebXR entry point, when there is one. */
export function xrSystem(): XrSystem | null {
  if (typeof navigator === 'undefined') return null;
  const xr = (navigator as Navigator & { xr?: XrSystem }).xr;
  return xr !== undefined && xr !== null && typeof xr.isSessionSupported === 'function' ? xr : null;
}
