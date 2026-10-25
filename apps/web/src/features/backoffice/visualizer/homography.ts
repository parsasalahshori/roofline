// Pure maths for laying a flat drawing onto a photo by four corners (a homography), as a CSS matrix3d.
export type Pt = readonly [number, number];
export type Quad = readonly [Pt, Pt, Pt, Pt];
/** A 3x3 matrix, row-major: [h11,h12,h13, h21,h22,h23, h31,h32,h33]. */
export type Homography = readonly number[];

/** Solve A x = b (n x n) by Gaussian elimination with partial pivoting; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r]![n]!;
    for (let c = r + 1; c < n; c++) sum -= m[r]![c]! * x[c]!;
    x[r] = sum / m[r]![r]!;
  }
  return x;
}

/** The homography taking the four `from` points to the four `to` points (in order); null when the points are degenerate. */
export function homography(from: Quad, to: Quad): Homography | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [u, v] = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(a, b);
  return h === null ? null : [...h, 1];
}

/** Where a point lands. */
export function applyHomography(h: Homography, [x, y]: Pt): Pt {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

/** The CSS `matrix3d(...)` for an element laid out at the stage's origin (transform-origin: 0 0) with sizes in px. */
export function cssMatrix3d(h: Homography): string {
  const n = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Number(v.toPrecision(10)));
  return `matrix3d(${[h[0]!, h[3]!, 0, h[6]!, h[1]!, h[4]!, 0, h[7]!, 0, 0, 1, 0, h[2]!, h[5]!, 0, h[8]!].map(n).join(',')})`;
}

/**
 * The transform that lays a drawing onto the photo. `srcRect` is where the unit's outer frame sits inside the drawing
 * element (px); `corners` are the placement's corners as 0..1 of the photo; `stageW`/`stageH` the photo's size on screen (px).
 */
export function placementTransform(srcRect: { x: number; y: number; w: number; h: number }, corners: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]], stageW: number, stageH: number): string | null {
  const from: Quad = [[srcRect.x, srcRect.y], [srcRect.x + srcRect.w, srcRect.y], [srcRect.x + srcRect.w, srcRect.y + srcRect.h], [srcRect.x, srcRect.y + srcRect.h]];
  const to = corners.map(([x, y]) => [x * stageW, y * stageH] as const) as unknown as Quad;
  const h = homography(from, to);
  return h === null ? null : cssMatrix3d(h);
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

/**
 * A starting placement for a unit: a rectangle of its shape (width = `share` of the photo's width) centred at
 * (cx, cy), 0..1 of the photo. `photoAspect` is the photo's width / height, `unitAspect` the unit's width / height.
 */
export function defaultCorners(unitAspect: number, photoAspect: number, cx = 0.5, cy = 0.5, share = 0.2): [[number, number], [number, number], [number, number], [number, number]] {
  let fw = share;
  let fh = (fw * photoAspect) / unitAspect;
  if (fh > 0.6) {
    fh = 0.6;
    fw = (fh * unitAspect) / photoAspect;
  }
  const x0 = Math.min(Math.max(cx - fw / 2, 0.02), 0.98 - fw);
  const y0 = Math.min(Math.max(cy - fh / 2, 0.02), 0.98 - fh);
  return [
    [clamp01(x0), clamp01(y0)],
    [clamp01(x0 + fw), clamp01(y0)],
    [clamp01(x0 + fw), clamp01(y0 + fh)],
    [clamp01(x0), clamp01(y0 + fh)],
  ];
}
