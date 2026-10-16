import { INCHES_PER_METRE, type ArPoint, type ArQuad, type Quad } from '@roofline/shared';
import type { XrMatrix } from './xr.ts';

/** 4x4 column-major (WebGL / WebXR) times a point (w = 1): [x, y, z, w]. */
export function transformPoint(m: XrMatrix, [x, y, z]: ArPoint): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

/** a x b, both 4x4 column-major. */
export function multiply(a: XrMatrix, b: XrMatrix): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}

/**
 * AR world points (metres) to pixels of a camera image `widthPx` x `heightPx` seen through one XR view: the view
 * matrix (world -> view: view.transform.inverse.matrix) then the view's projection matrix, then the viewport (y down).
 * Null when a point is behind the camera. Points a little outside the image are kept inside it (the server wants
 * corners on the photo).
 */
export function projectToImage(points: readonly ArPoint[], viewMatrix: XrMatrix, projectionMatrix: XrMatrix, widthPx: number, heightPx: number): [number, number][] | null {
  const out: [number, number][] = [];
  for (const p of points) {
    const v = transformPoint(viewMatrix, p);
    const c = transformPoint(projectionMatrix, [v[0] / v[3], v[1] / v[3], v[2] / v[3]]);
    // A perspective projection carries -z into w: a point at or behind the camera has w <= 0
    const w = c[3];
    if (!(w > 1e-6)) return null;
    const x = ((c[0] / w + 1) / 2) * widthPx;
    const y = ((1 - c[1] / w) / 2) * heightPx;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([Math.round(Math.min(widthPx, Math.max(0, x)) * 10) / 10, Math.round(Math.min(heightPx, Math.max(0, y)) * 10) / 10]);
  }
  return out;
}

/** The photo inset 15% on every side (TL, TR, BR, BL): where the corners go when AR's points cannot be drawn into it. */
export function insetCorners(widthPx: number, heightPx: number): Quad {
  const x0 = Math.round(widthPx * 0.15);
  const x1 = Math.round(widthPx * 0.85);
  const y0 = Math.round(heightPx * 0.15);
  const y1 = Math.round(heightPx * 0.85);
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Distance between two AR points, inches. */
export function inchesBetween(a: ArPoint, b: ArPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * INCHES_PER_METRE;
}

/** The sides drawn so far, inches: between the placed corners in order, and from the last one to the aim point. */
export function liveEdges(points: readonly ArPoint[], aim: ArPoint | null): { inches: number; toAim: boolean }[] {
  const out: { inches: number; toAim: boolean }[] = [];
  for (let i = 1; i < points.length; i++) out.push({ inches: inchesBetween(points[i - 1]!, points[i]!), toAim: false });
  if (points.length === 4) out.push({ inches: inchesBetween(points[3]!, points[0]!), toAim: false });
  else if (aim !== null && points.length > 0) out.push({ inches: inchesBetween(points[points.length - 1]!, aim), toAim: true });
  return out;
}

export const asQuad = (points: readonly ArPoint[]): ArQuad | null => (points.length === 4 ? (points.map((p) => [p[0], p[1], p[2]]) as ArQuad) : null);
