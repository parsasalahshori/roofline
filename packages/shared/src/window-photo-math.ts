// Sizing a window from a photo someone takes of it, with no AI: plane geometry only.
// - With a reference of known size on the glass (a sheet of printer paper), the homography from the reference's four
//   corners to its real rectangle maps the window's four corners into inches.
// - With one side measured by hand, the window's own four corners give its true width:height ratio (a rectangle seen
//   at an angle, given the camera's focal length) and the measured side scales it.
// Points are photo pixels; quads are ordered top-left, top-right, bottom-right, bottom-left.

export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt];
type V3 = [number, number, number];

/** 3x3 homography, row-major, mapping src -> dst. Null when the points are degenerate (three in a line). */
export function homography(src: Quad, dst: Quad): number[] | null {
  // Direct linear transform with h33 = 1: eight equations, eight unknowns.
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [u, v] = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return h === null ? null : [...h, 1];
}

export function applyHomography(H: number[], [x, y]: Pt): Pt {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}

/** Gaussian elimination with partial pivoting. Null for a singular system. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Width and height of a quad that is already in inches: the mean of opposite sides. */
function quadSize(q: Quad): { widthIn: number; heightIn: number } {
  return { widthIn: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2, heightIn: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 };
}

/**
 * The window's size in inches from a reference rectangle of known size lying in the same plane (taped to the glass).
 * Null when the reference corners are degenerate.
 */
export function sizeFromReference(windowQuad: Quad, referenceQuad: Quad, refWidthIn: number, refHeightIn: number): { widthIn: number; heightIn: number } | null {
  const real: Quad = [[0, 0], [refWidthIn, 0], [refWidthIn, refHeightIn], [0, refHeightIn]];
  const H = homography(referenceQuad, real);
  if (H === null) return null;
  return quadSize(windowQuad.map((p) => applyHomography(H, p)) as Quad);
}

/** Focal length in pixels from the 35 mm-equivalent focal length a phone writes into the photo (36 mm-wide frame). */
export function focalPxFrom35mm(focal35mm: number, widthPx: number, heightPx: number): number {
  return (focal35mm / 36) * Math.max(widthPx, heightPx);
}

/** A typical phone main camera (about 26 mm equivalent) when the photo does not say. */
export const DEFAULT_FOCAL_35MM = 26;

/**
 * The true width:height of a rectangle from its four corners in one photo (Zhang and He, "Whiteboard scanning",
 * 2007). The principal point is taken at the photo's centre. Falls back to the plain side ratio when the rectangle is
 * seen straight on (the perspective terms vanish). Null for a degenerate quad.
 */
export function rectangleAspect(q: Quad, widthPx: number, heightPx: number, focalPx: number): number | null {
  const cx = widthPx / 2;
  const cy = heightPx / 2;
  // Zhang's corner order: m1 = (0,0), m2 = (w,0), m3 = (0,h), m4 = (w,h).
  const h = (p: Pt): V3 => [p[0] - cx, p[1] - cy, 1];
  const m1 = h(q[0]);
  const m2 = h(q[1]);
  const m3 = h(q[3]);
  const m4 = h(q[2]);
  const k2den = dot(cross(m2, m4), m3);
  const k3den = dot(cross(m3, m4), m2);
  if (Math.abs(k2den) < 1e-9 || Math.abs(k3den) < 1e-9) return null;
  const k2 = dot(cross(m1, m4), m3) / k2den;
  const k3 = dot(cross(m1, m4), m2) / k3den;
  const n2: V3 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3: V3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const f2 = focalPx * focalPx;
  const num = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
  const den = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
  if (!(num > 0) || !(den > 0)) return null;
  return Math.sqrt(num / den);
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The window's size from its corners and one side measured by hand. Null for a degenerate quad. */
export function sizeFromKnownSide(
  q: Quad,
  widthPx: number,
  heightPx: number,
  side: 'width' | 'height',
  inches: number,
  focalPx: number = focalPxFrom35mm(DEFAULT_FOCAL_35MM, widthPx, heightPx),
): { widthIn: number; heightIn: number } | null {
  const aspect = rectangleAspect(q, widthPx, heightPx, focalPx);
  if (aspect === null) return null;
  return side === 'width' ? { widthIn: inches, heightIn: inches / aspect } : { widthIn: inches * aspect, heightIn: inches };
}
