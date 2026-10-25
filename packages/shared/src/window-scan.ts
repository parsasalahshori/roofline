import { INCHES_PER_METRE } from './window-photo-math.ts';

/*
 * Multi-frame window scan: the math both the server and the staff review screen run (and the iPhone's RooflineCore, which
 * checks the same fixtures: packages/shared/test/fixtures/window-scan). The contract, with every convention below, is
 * docs/windows/scan-contract.md. In short: each corner of the window is marked on several frames, every mark is a ray
 * through the camera, the corner is the point closest to all of its rays (closed form), the four corners are fitted with a
 * level rectangle (RooflineCore RectangleFit, level only), and seven quality gates say whether a person must look.
 *
 * World space is ARKit's (metres, +Y up). A camera transform is 16 numbers, COLUMN-MAJOR (translation = m[12..14]); the
 * camera looks along its own -z, +x right, +y up. Image points are pixels of the NATIVE landscape camera image the
 * intrinsics describe (origin top-left, y down). The uploaded JPEG may be a resized copy of that image: it is drawn at
 * `imageWidth / intrinsics.width` of the native pixels (`scanImageScale`), nothing else changes.
 */

export type ScanVec3 = [number, number, number];
/** A column-major 4x4 rigid transform, 16 numbers. */
export type ScanMat4 = readonly number[];

export type ScanIntrinsics = { fx: number; fy: number; cx: number; cy: number; width: number; height: number };
export type ScanCorner = 0 | 1 | 2 | 3;
export const SCAN_CORNERS = [0, 1, 2, 3] as const;
export const SCAN_CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'] as const;
export type ScanFrameKind = 'regular' | 'closeup';
export const SCAN_FRAME_KINDS = ['regular', 'closeup'] as const;
export const SCAN_MARK_SOURCES = ['ai', 'snap', 'projected', 'user'] as const;
export type ScanMarkSource = (typeof SCAN_MARK_SOURCES)[number];

export type ScanFrame = {
  frameId: string;
  kind: ScanFrameKind;
  /** The corner a close-up is of; null for a regular frame. */
  corner: ScanCorner | null;
  uploadId: string;
  imageWidth: number;
  imageHeight: number;
  cameraTransform: number[];
  intrinsics: ScanIntrinsics;
};

export type ScanMark = { frameId: string; corner: ScanCorner; x: number; y: number; source: ScanMarkSource };
export type ScanWall = { point: ScanVec3; normal: ScanVec3 };

/* ------------------------------------------------------------------------------------------------------------------ */
/* Limits and thresholds (the contract's table)                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

export const SCAN_LIMITS = {
  minFrames: 3,
  maxFrames: 24,
  maxMarks: 200,
  /** Every corner needs at least this many marks used for triangulation. */
  minMarksPerCorner: 3,
  /** RMS reprojection error over all marks, px. */
  reprojRmsPx: 3.0,
  /** Any single mark, px. */
  reprojMaxPx: 8.0,
  /** The largest angle between the rays of a corner must reach this, degrees. */
  baselineDeg: 4,
  /** Opposite sides of the triangulated quad may differ by this many inches... */
  symDiffIn: 0.75,
  /** ...or this share of their mean (2%). */
  symDiffShare: 0.02,
  /** A corner may be this far from the corners' least-squares plane, centimetres. */
  planeMaxCm: 1.0,
  /** The triangulated size may differ from the single-frame (wall plane) size by this share. */
  scaleDiff: 0.03,
  /** Close-ups wanted (a warning only). */
  minCloseups: 2,
  /** Smallest eigenvalue of the triangulation normal matrix, per ray. */
  conditionPerRay: 1e-6,
  /** A review SLA starts at the scan's creation (hours). */
  slaHours: 24,
} as const;

export const SCAN_GATE_CODES = ['too_few_frames', 'reprojection', 'baseline', 'sym_ratio', 'plane', 'scale', 'no_closeups'] as const;
export type ScanGateCode = (typeof SCAN_GATE_CODES)[number];

/** What the reviewer is told, in plain words, for each gate. */
export const SCAN_GATE_LABELS: Record<ScanGateCode, string> = {
  too_few_frames: 'Every corner on at least 3 frames',
  reprojection: 'Marks agree with the corners (reprojection)',
  baseline: 'Frames far enough apart (baseline)',
  sym_ratio: 'Opposite sides match',
  plane: 'Corners lie in one plane',
  scale: 'Size matches the wall plane',
  no_closeups: 'At least 2 close-ups',
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Small vector and matrix helpers                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

const add = (a: ScanVec3, b: ScanVec3): ScanVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: ScanVec3, b: ScanVec3): ScanVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: ScanVec3, s: number): ScanVec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: ScanVec3, b: ScanVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ScanVec3, b: ScanVec3): ScanVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: ScanVec3): number => Math.hypot(a[0], a[1], a[2]);
const dist = (a: ScanVec3, b: ScanVec3): number => len(sub(a, b));
const finite3 = (a: ScanVec3): boolean => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
function unit(a: ScanVec3): ScanVec3 | null {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : null;
}
function meanOf(ps: readonly ScanVec3[]): ScanVec3 | null {
  if (ps.length === 0) return null;
  let s: ScanVec3 = [0, 0, 0];
  for (const p of ps) s = add(s, p);
  return mul(s, 1 / ps.length);
}

/** The camera's position in the world (the transform's translation). */
export function scanCameraPosition(m: ScanMat4): ScanVec3 {
  return [m[12]!, m[13]!, m[14]!];
}

/** A rigid transform applied to a point: R p + t. */
export function scanMat4Transform(m: ScanMat4, p: ScanVec3): ScanVec3 {
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}

/** The rotation only (a direction): R d. */
export function scanMat4Rotate(m: ScanMat4, d: ScanVec3): ScanVec3 {
  return [m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2], m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2], m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2]];
}

/** The inverse of a rigid (rotation + translation) column-major transform: Rᵀ and -Rᵀt. */
export function scanMat4InverseRigid(m: ScanMat4): number[] {
  const [m0, m1, m2, m4, m5, m6, m8, m9, m10, tx, ty, tz] = [m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!, m[12]!, m[13]!, m[14]!];
  return [m0, m4, m8, 0, m1, m5, m9, 0, m2, m6, m10, 0, -(m0 * tx + m1 * ty + m2 * tz), -(m4 * tx + m5 * ty + m6 * tz), -(m8 * tx + m9 * ty + m10 * tz), 1];
}

/** Whether 16 numbers are a usable rigid transform: finite, bottom row 0 0 0 1, and an orthonormal rotation. */
export function scanTransformProblem(m: readonly number[]): string | null {
  if (m.length !== 16 || !m.every((v) => Number.isFinite(v))) return 'The camera transform is not 16 numbers.';
  if (Math.abs(m[3]!) > 1e-6 || Math.abs(m[7]!) > 1e-6 || Math.abs(m[11]!) > 1e-6 || Math.abs(m[15]! - 1) > 1e-6) return 'The camera transform is not a rigid 4x4.';
  const cols: ScanVec3[] = [
    [m[0]!, m[1]!, m[2]!],
    [m[4]!, m[5]!, m[6]!],
    [m[8]!, m[9]!, m[10]!],
  ];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(len(cols[i]!) - 1) > 1e-3) return 'The camera transform is not a rotation.';
    for (let j = i + 1; j < 3; j++) if (Math.abs(dot(cols[i]!, cols[j]!)) > 1e-3) return 'The camera transform is not a rotation.';
  }
  return null;
}

/** World point to native image pixels; null when it is at or behind the camera (RooflineCore `ImageMapping.project`). */
export function scanProject(p: ScanVec3, cameraTransform: ScanMat4, k: ScanIntrinsics): [number, number] | null {
  const inv = scanMat4InverseRigid(cameraTransform);
  const c = scanMat4Transform(inv, p);
  if (!(c[2] < -1e-4)) return null;
  const depth = -c[2];
  return [k.cx + (k.fx * c[0]) / depth, k.cy - (k.fy * c[1]) / depth];
}

/** The ray through a native image pixel: origin = the camera, direction = unit, in the world. */
export function scanRay(x: number, y: number, cameraTransform: ScanMat4, k: ScanIntrinsics): { origin: ScanVec3; dir: ScanVec3 } {
  const camera: ScanVec3 = [(x - k.cx) / k.fx, -(y - k.cy) / k.fy, -1];
  const dir = unit(scanMat4Rotate(cameraTransform, camera))!;
  return { origin: scanCameraPosition(cameraTransform), dir };
}

/** The uploaded JPEG is drawn at this many of its pixels per native pixel (1 when it is the native image itself). */
export function scanImageScale(f: Pick<ScanFrame, 'imageWidth' | 'imageHeight' | 'intrinsics'>): { sx: number; sy: number } {
  return { sx: f.imageWidth / f.intrinsics.width, sy: f.imageHeight / f.intrinsics.height };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Eigen decomposition and plane fit (RooflineCore Plane.swift)                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Eigen decomposition of a symmetric 3x3 matrix (cyclic Jacobi). Eigenvalues ascending, with their unit vectors. */
export function symmetricEigen3(input: readonly (readonly number[])[]): { values: number[]; vectors: number[][] } {
  const a = input.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const pairs3: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    const off = a[0]![1]! ** 2 + a[0]![2]! ** 2 + a[1]![2]! ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of pairs3) {
      if (Math.abs(a[p]![q]!) < 1e-300) continue;
      const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k]![p]!;
        const akq = a[k]![q]!;
        a[k]![p] = c * akp - s * akq;
        a[k]![q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p]![k]!;
        const aqk = a[q]![k]!;
        a[p]![k] = c * apk - s * aqk;
        a[q]![k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const pairs = [0, 1, 2].map((i) => ({ value: a[i]![i]!, vector: [v[0]![i]!, v[1]![i]!, v[2]![i]!] })).sort((x, y) => x.value - y.value);
  return { values: pairs.map((p) => p.value), vectors: pairs.map((p) => p.vector) };
}

export type ScanPlane = { point: ScanVec3; normal: ScanVec3 };

/** Least-squares plane through the points; null for fewer than three, or points in (nearly) a line. */
export function scanFitPlane(points: readonly ScanVec3[]): ScanPlane | null {
  if (points.length < 3) return null;
  const c = meanOf(points)!;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i]![j]! += d[i]! * d[j]!;
  }
  const { values, vectors } = symmetricEigen3(m);
  const spread = values[2]!;
  if (!(spread > 1e-12) || !(values[1]! > spread * 1e-8)) return null;
  const normal = unit([vectors[0]![0]!, vectors[0]![1]!, vectors[0]![2]!]);
  return normal === null ? null : { point: c, normal };
}

const signedDistance = (pl: ScanPlane, p: ScanVec3): number => dot(sub(p, pl.point), pl.normal);

/* ------------------------------------------------------------------------------------------------------------------ */
/* Triangulation                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ScanRay = { origin: ScanVec3; dir: ScanVec3 };

/**
 * The point P minimising the sum of squared distances to the rays: P = (sum A_i)^-1 sum A_i o_i with A_i = I - d d^T.
 * Null for fewer than two rays or a badly conditioned system (smallest eigenvalue of sum A_i under 1e-6 per ray: the
 * rays are (nearly) parallel).
 */
export function scanTriangulate(rays: readonly ScanRay[]): ScanVec3 | null {
  const n = rays.length;
  if (n < 2) return null;
  const s = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const b: ScanVec3 = [0, 0, 0];
  for (const { origin: o, dir: d } of rays) {
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) s[i]![j]! += (i === j ? 1 : 0) - d[i]! * d[j]!;
      // A_i o_i
      b[i]! += o[i]! - d[i]! * dot(d, o);
    }
  }
  const { values } = symmetricEigen3(s);
  if (!(values[0]! >= SCAN_LIMITS.conditionPerRay * n)) return null;
  const det =
    s[0]![0]! * (s[1]![1]! * s[2]![2]! - s[1]![2]! * s[2]![1]!) - s[0]![1]! * (s[1]![0]! * s[2]![2]! - s[1]![2]! * s[2]![0]!) + s[0]![2]! * (s[1]![0]! * s[2]![1]! - s[1]![1]! * s[2]![0]!);
  if (!(Math.abs(det) > 1e-30)) return null;
  const inv = [
    [(s[1]![1]! * s[2]![2]! - s[1]![2]! * s[2]![1]!) / det, (s[0]![2]! * s[2]![1]! - s[0]![1]! * s[2]![2]!) / det, (s[0]![1]! * s[1]![2]! - s[0]![2]! * s[1]![1]!) / det],
    [(s[1]![2]! * s[2]![0]! - s[1]![0]! * s[2]![2]!) / det, (s[0]![0]! * s[2]![2]! - s[0]![2]! * s[2]![0]!) / det, (s[0]![2]! * s[1]![0]! - s[0]![0]! * s[1]![2]!) / det],
    [(s[1]![0]! * s[2]![1]! - s[1]![1]! * s[2]![0]!) / det, (s[0]![1]! * s[2]![0]! - s[0]![0]! * s[2]![1]!) / det, (s[0]![0]! * s[1]![1]! - s[0]![1]! * s[1]![0]!) / det],
  ];
  const p: ScanVec3 = [dot(inv[0]! as ScanVec3, b), dot(inv[1]! as ScanVec3, b), dot(inv[2]! as ScanVec3, b)];
  return finite3(p) ? p : null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The level rectangle (RooflineCore RectangleFit.swift, level only)                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export const SCAN_FIT_LIMITS = {
  /** The placed corners disagree with the rectangle when opposite sides differ by more than this, inches... */
  sideDiffIn: 0.75,
  /** ...or by more than this share of their mean, or a corner is further than `sideDiffIn` from where the rectangle puts it. */
  sideDiffShare: 0.02,
  culpritMarginIn: 0.4,
  culpritMaxShare: 0.45,
} as const;

export type ScanRectangleFit = {
  /** The fitted rectangle, TL, TR, BR, BL, on the wall's plane (world metres). */
  pointsM: ScanVec3[];
  /** The corners as given (projected onto the plane). */
  rawPointsM: ScanVec3[];
  widthIn: number;
  heightIn: number;
  /** How far each given corner is from its rectangle corner, inches. */
  residualIn: number[];
  topIn: number;
  bottomIn: number;
  leftIn: number;
  rightIn: number;
  disagrees: boolean;
  /** The corner whose placement explains the disagreement, when it is clearly one corner. */
  worstCorner: ScanCorner | null;
};

/**
 * The best rectangle for four corners (TL, TR, BR, BL) already on `plane`, as seen from `viewer`: level with gravity (+Y)
 * in the plane; the left side is the mean of the two left corners' positions, the right of the two right ones', the top and
 * bottom likewise (the least-squares fit). Null for a plane with no "up" in it (a floor, a skylight) or corners that make
 * no rectangle.
 */
export function scanFitRectangle(raw: readonly ScanVec3[], plane: ScanPlane, viewer: ScanVec3): ScanRectangleFit | null {
  if (raw.length !== 4 || !raw.every(finite3)) return null;
  const c = meanOf(raw)!;
  let n = unit(plane.normal);
  if (n === null) return null;
  if (dot(sub(viewer, c), n) < 0) n = mul(n, -1);
  const upIn = sub([0, 1, 0], mul(n, dot([0, 1, 0], n)));
  const up = unit(upIn);
  if (up === null || len(upIn) <= 0.25) return null;
  const right = cross(up, n);
  const st = raw.map((p) => {
    const d = sub(p, c);
    return { s: dot(d, right), t: dot(d, up) };
  });
  const left = (st[0]!.s + st[3]!.s) / 2;
  const rightS = (st[1]!.s + st[2]!.s) / 2;
  const top = (st[0]!.t + st[1]!.t) / 2;
  const bottom = (st[3]!.t + st[2]!.t) / 2;
  if (!(rightS - left > 1e-4) || !(top - bottom > 1e-4)) return null;
  const fitted = (
    [
      [left, top],
      [rightS, top],
      [rightS, bottom],
      [left, bottom],
    ] as const
  ).map(([s, t]) => add(c, add(mul(right, s), mul(up, t))) as ScanVec3);

  const residualIn = raw.map((p, i) => dist(p, fitted[i]!) * INCHES_PER_METRE);
  const topIn = dist(raw[0]!, raw[1]!) * INCHES_PER_METRE;
  const bottomIn = dist(raw[3]!, raw[2]!) * INCHES_PER_METRE;
  const leftIn = dist(raw[0]!, raw[3]!) * INCHES_PER_METRE;
  const rightIn = dist(raw[1]!, raw[2]!) * INCHES_PER_METRE;
  const widthIn = (rightS - left) * INCHES_PER_METRE;
  const heightIn = (top - bottom) * INCHES_PER_METRE;
  const differs = (x: number, y: number): boolean => {
    const d = Math.abs(x - y);
    return d > SCAN_FIT_LIMITS.sideDiffIn || d / Math.max((x + y) / 2, 1e-9) > SCAN_FIT_LIMITS.sideDiffShare;
  };
  const disagrees = differs(topIn, bottomIn) || differs(leftIn, rightIn) || Math.max(...residualIn) > SCAN_FIT_LIMITS.sideDiffIn;

  // Which corner? The one whose removal leaves the other three agreeing best (the horizontal edge must be level, the vertical upright)
  const level = (i: number, j: number) => Math.abs(st[i]!.t - st[j]!.t);
  const upright = (i: number, j: number) => Math.abs(st[i]!.s - st[j]!.s);
  const edges: { corners: number[]; off: number }[] = [
    { corners: [0, 1], off: level(0, 1) },
    { corners: [3, 2], off: level(3, 2) },
    { corners: [0, 3], off: upright(0, 3) },
    { corners: [1, 2], off: upright(1, 2) },
  ];
  const explained = [0, 1, 2, 3].map((i) => {
    const rest = edges.filter((e) => !e.corners.includes(i));
    return Math.sqrt(rest.reduce((s, e) => s + e.off * e.off, 0) / 2) * INCHES_PER_METRE;
  });
  const ranked = [0, 1, 2, 3].sort((a, b) => explained[a]! - explained[b]!);
  const winner = ranked[0]!;
  const runnerUp = explained[ranked[1]!]!;
  const worst = runnerUp >= SCAN_FIT_LIMITS.culpritMarginIn && explained[winner]! <= SCAN_FIT_LIMITS.culpritMaxShare * runnerUp ? (winner as ScanCorner) : null;

  return { pointsM: fitted, rawPointsM: [...raw], widthIn, heightIn, residualIn, topIn, bottomIn, leftIn, rightIn, disagrees, worstCorner: worst };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The scan result                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ScanGate = {
  code: ScanGateCode;
  passed: boolean;
  /** A warning never fails the scan on its own (no_closeups). */
  warning: boolean;
  /** The measured value and the limit, in plain words for the reviewer. */
  detail: string;
};

export type ScanQuality = {
  framesPerCorner: [number, number, number, number];
  reprojRmsPx: number;
  reprojMaxPx: number;
  minBaselineDeg: number;
  symRatioDiff: number;
  planeMaxCm: number;
  scaleDiff: number;
  closeups: number;
  failed: ScanGateCode[];
};

/** One mark's reprojection error against the triangulated corner, in native pixels. */
export type ScanMarkError = { frameId: string; corner: ScanCorner; errorPx: number };

export type ScanComputation = {
  /** The four triangulated corners as they came out (before the rectangle fit); null where a corner could not be. */
  triangulatedM: (ScanVec3 | null)[];
  /** The fitted level rectangle's corners (the opening); null when the four corners did not make one. */
  cornersM: ScanVec3[] | null;
  widthIn: number | null;
  heightIn: number | null;
  fit: ScanRectangleFit | null;
  markErrors: ScanMarkError[];
  /** Per corner: marks used, the widest angle between its rays, and its RMS reprojection error. */
  perCorner: { used: number; baselineDeg: number; rmsPx: number }[];
  quality: ScanQuality;
  gates: ScanGate[];
  status: 'measured' | 'needs_review';
  /** The size the wall plane alone gives, when it could be worked out. */
  singleFrameIn: { widthIn: number; heightIn: number } | null;
};

/** The result as the contract writes it (the phone sends this; the server answers it, with `triangulatedM` added). */
export type ScanResult = {
  cornersM: ScanVec3[] | null;
  widthIn: number | null;
  heightIn: number | null;
  windowFrame: { widthIn: number; heightIn: number; estimated: boolean } | null;
  quality: ScanQuality;
  status: 'measured' | 'needs_review';
  /** Additive (server only): the corners as triangulated, before the rectangle fit. */
  triangulatedM?: (ScanVec3 | null)[];
};

const round = (v: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

/** The marks to use: one per (frame, corner) (the last wins), on frames that exist and with finite coordinates. */
export function scanUsableMarks(frames: readonly ScanFrame[], marks: readonly ScanMark[]): ScanMark[] {
  const ids = new Set(frames.map((f) => f.frameId));
  const byKey = new Map<string, ScanMark>();
  for (const m of marks) {
    if (!ids.has(m.frameId) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
    byKey.set(`${m.frameId}\u0000${m.corner}`, m);
  }
  return [...byKey.values()];
}

function maxAngleDeg(dirs: readonly ScanVec3[]): number {
  let best = 0;
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      const c = Math.max(-1, Math.min(1, dot(dirs[i]!, dirs[j]!)));
      best = Math.max(best, (Math.acos(c) * 180) / Math.PI);
    }
  }
  return best;
}

const median = (vs: number[]): number => {
  const s = [...vs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * The size one frame alone gives: its four rays met with the wall plane, the level rectangle fitted to the four points.
 * The median over the frames that mark all four corners. Null without a wall, or when no frame gives one.
 */
function singleFrameSize(frames: readonly ScanFrame[], marks: readonly ScanMark[], wall: ScanWall | null, viewer: ScanVec3): { widthIn: number; heightIn: number } | null {
  if (wall === null) return null;
  const normal = unit(wall.normal);
  if (normal === null || !finite3(wall.point)) return null;
  const plane: ScanPlane = { point: wall.point, normal };
  const widths: number[] = [];
  const heights: number[] = [];
  for (const f of frames) {
    const mine = marks.filter((m) => m.frameId === f.frameId);
    if (!SCAN_CORNERS.every((c) => mine.some((m) => m.corner === c))) continue;
    const pts: ScanVec3[] = [];
    for (const c of SCAN_CORNERS) {
      const m = mine.find((x) => x.corner === c)!;
      const { origin, dir } = scanRay(m.x, m.y, f.cameraTransform, f.intrinsics);
      const denom = dot(dir, normal);
      if (Math.abs(denom) < 1e-6) break;
      const t = dot(sub(plane.point, origin), normal) / denom;
      if (!(t > 0) || !Number.isFinite(t)) break;
      pts.push(add(origin, mul(dir, t)));
    }
    if (pts.length !== 4) continue;
    const fit = scanFitRectangle(pts, plane, viewer);
    if (fit === null) continue;
    widths.push(fit.widthIn);
    heights.push(fit.heightIn);
  }
  return widths.length === 0 ? null : { widthIn: median(widths), heightIn: median(heights) };
}

/**
 * Triangulates the four corners from the marks, fits the level rectangle, and runs the quality gates. Pure: the server runs
 * it on a phone's scan, the staff screen runs it on every dragged mark. `wall` (the phone's wall plane) is only for the
 * `scale` gate, which is skipped (and passes) without it.
 */
export function computeScanResult(frames: readonly ScanFrame[], marks: readonly ScanMark[], wall: ScanWall | null): ScanComputation {
  const frameById = new Map(frames.map((f) => [f.frameId, f]));
  const used = scanUsableMarks(frames, marks);
  const perCornerMarks = SCAN_CORNERS.map((c) => used.filter((m) => m.corner === c));
  const rays = perCornerMarks.map((list) =>
    list.map((m) => {
      const f = frameById.get(m.frameId)!;
      return scanRay(m.x, m.y, f.cameraTransform, f.intrinsics);
    }),
  );
  const triangulatedM = rays.map((r) => scanTriangulate(r));

  // Reprojection of every mark against its corner
  const markErrors: ScanMarkError[] = [];
  const cornerSq = [0, 0, 0, 0];
  const cornerN = [0, 0, 0, 0];
  perCornerMarks.forEach((list, c) => {
    const p = triangulatedM[c];
    if (p === null || p === undefined) return;
    for (const m of list) {
      const f = frameById.get(m.frameId)!;
      const proj = scanProject(p, f.cameraTransform, f.intrinsics);
      // A corner behind the camera is as wrong as it gets
      const e = proj === null ? 9999 : Math.min(9999, Math.hypot(proj[0] - m.x, proj[1] - m.y));
      markErrors.push({ frameId: m.frameId, corner: c as ScanCorner, errorPx: e });
      cornerSq[c]! += e * e;
      cornerN[c]! += 1;
    }
  });
  const totalN = cornerN.reduce((a, b) => a + b, 0);
  const reprojRmsPx = totalN === 0 ? 0 : Math.sqrt(cornerSq.reduce((a, b) => a + b, 0) / totalN);
  const reprojMaxPx = markErrors.reduce((m, e) => Math.max(m, e.errorPx), 0);
  const baselines = rays.map((r) => (r.length < 2 ? 0 : maxAngleDeg(r.map((x) => x.dir))));
  const minBaselineDeg = Math.min(...baselines);
  const framesPerCorner = perCornerMarks.map((l) => l.length) as [number, number, number, number];

  // Rectangle: the four corners on their least-squares plane, fitted level, seen from where the frames were
  const all4 = triangulatedM.every((p): p is ScanVec3 => p !== null);
  let fit: ScanRectangleFit | null = null;
  let planeMaxCm = 0;
  let planeOk = true;
  let symRatioDiff = 0;
  let symDiffIn = 0;
  const usedFrames = [...new Set(used.map((m) => m.frameId))].map((id) => frameById.get(id)!);
  const viewer = meanOf(usedFrames.map((f) => scanCameraPosition(f.cameraTransform))) ?? [0, 0, 0];
  if (all4) {
    const pts = triangulatedM as ScanVec3[];
    const plane = scanFitPlane(pts);
    if (plane === null) {
      planeOk = false;
    } else {
      planeMaxCm = Math.max(...pts.map((p) => Math.abs(signedDistance(plane, p)))) * 100;
      fit = scanFitRectangle(
        pts.map((p) => sub(p, mul(plane.normal, signedDistance(plane, p)))),
        plane,
        viewer,
      );
      if (fit === null) planeOk = false;
    }
    // Opposite sides of the triangulated quad (3-D lengths)
    const side = (a: number, b: number) => dist(pts[a]!, pts[b]!) * INCHES_PER_METRE;
    for (const [x, y] of [
      [side(0, 1), side(3, 2)],
      [side(0, 3), side(1, 2)],
    ] as const) {
      symDiffIn = Math.max(symDiffIn, Math.abs(x - y));
      symRatioDiff = Math.max(symRatioDiff, Math.abs(x - y) / Math.max((x + y) / 2, 1e-9));
    }
  }

  // Scale against what the wall plane alone gives
  const singleFrameIn = fit === null ? null : singleFrameSize(frames, used, wall, viewer);
  let scaleDiff = 0;
  if (fit !== null && singleFrameIn !== null) {
    scaleDiff = Math.max(Math.abs(fit.widthIn - singleFrameIn.widthIn) / singleFrameIn.widthIn, Math.abs(fit.heightIn - singleFrameIn.heightIn) / singleFrameIn.heightIn);
  }
  const closeups = new Set(used.filter((m) => frameById.get(m.frameId)!.kind === 'closeup').map((m) => m.frameId)).size;

  const L = SCAN_LIMITS;
  const fixed = (v: number, d = 2) => v.toFixed(d);
  const gates: ScanGate[] = [
    {
      code: 'too_few_frames',
      passed: framesPerCorner.every((n) => n >= L.minMarksPerCorner),
      warning: false,
      detail: `Frames per corner ${framesPerCorner.join(', ')} (need ${L.minMarksPerCorner} or more each)`,
    },
    {
      code: 'reprojection',
      passed: totalN > 0 && reprojRmsPx <= L.reprojRmsPx && reprojMaxPx <= L.reprojMaxPx,
      warning: false,
      detail: totalN === 0 ? 'No corner could be triangulated' : `RMS ${fixed(reprojRmsPx)} px (limit ${L.reprojRmsPx}), worst ${fixed(reprojMaxPx)} px (limit ${L.reprojMaxPx})`,
    },
    {
      code: 'baseline',
      passed: minBaselineDeg >= L.baselineDeg && triangulatedM.every((p) => p !== null),
      warning: false,
      detail: `Widest angle between a corner's rays, smallest corner: ${fixed(minBaselineDeg, 1)} deg (need ${L.baselineDeg} or more)`,
    },
    {
      code: 'sym_ratio',
      passed: all4 && symDiffIn <= L.symDiffIn && symRatioDiff <= L.symDiffShare,
      warning: false,
      detail: all4 ? `Opposite sides differ by ${fixed(symDiffIn)} in, ${fixed(symRatioDiff * 100, 1)}% (limit ${L.symDiffIn} in or ${L.symDiffShare * 100}%)` : 'Needs all four corners',
    },
    {
      code: 'plane',
      passed: all4 && planeOk && planeMaxCm <= L.planeMaxCm,
      warning: false,
      detail: all4 ? `Farthest corner ${fixed(planeMaxCm)} cm from the plane (limit ${L.planeMaxCm} cm)` : 'Needs all four corners',
    },
    {
      code: 'scale',
      passed: scaleDiff <= L.scaleDiff,
      warning: false,
      detail: singleFrameIn === null ? 'Not checked (no wall plane or no frame sees all four corners)' : `Differs from the wall-plane size by ${fixed(scaleDiff * 100, 1)}% (limit ${L.scaleDiff * 100}%)`,
    },
    {
      code: 'no_closeups',
      passed: closeups >= L.minCloseups,
      warning: true,
      detail: `${closeups} close-up${closeups === 1 ? '' : 's'} used (want ${L.minCloseups} or more)`,
    },
  ];
  const failed = gates.filter((g) => !g.passed && !g.warning).map((g) => g.code);

  const quality: ScanQuality = {
    framesPerCorner,
    reprojRmsPx: round(reprojRmsPx, 3),
    reprojMaxPx: round(reprojMaxPx, 3),
    minBaselineDeg: round(minBaselineDeg, 2),
    symRatioDiff: round(symRatioDiff, 5),
    planeMaxCm: round(planeMaxCm, 3),
    scaleDiff: round(scaleDiff, 5),
    closeups,
    failed,
  };
  return {
    triangulatedM,
    cornersM: fit === null ? null : fit.pointsM,
    widthIn: fit === null ? null : fit.widthIn,
    heightIn: fit === null ? null : fit.heightIn,
    fit,
    markErrors,
    perCorner: SCAN_CORNERS.map((c) => ({ used: framesPerCorner[c], baselineDeg: baselines[c]!, rmsPx: cornerN[c] === 0 ? 0 : Math.sqrt(cornerSq[c]! / cornerN[c]!) })),
    quality,
    gates,
    status: failed.length === 0 ? 'measured' : 'needs_review',
    singleFrameIn,
  };
}

/** A computation as the contract's result object (what the server stores and answers); `windowFrame` is the phone's, kept as sent. */
export function scanResultOf(c: ScanComputation, windowFrame: ScanResult['windowFrame'] = null): ScanResult {
  return {
    cornersM: c.cornersM === null ? null : c.cornersM.map((p) => p.map((v) => round(v, 5)) as ScanVec3),
    widthIn: c.widthIn === null ? null : round(c.widthIn, 4),
    heightIn: c.heightIn === null ? null : round(c.heightIn, 4),
    windowFrame,
    quality: c.quality,
    status: c.status,
    triangulatedM: c.triangulatedM.map((p) => (p === null ? null : (p.map((v) => round(v, 5)) as ScanVec3))),
  };
}

/** Whether every frame in a scan has the right shape for the math (the staff screen and the API both refuse otherwise). */
export function scanFrameProblem(f: ScanFrame): string | null {
  const t = scanTransformProblem(f.cameraTransform);
  if (t !== null) return t;
  const k = f.intrinsics;
  if (![k.fx, k.fy, k.cx, k.cy, k.width, k.height].every((v) => Number.isFinite(v)) || k.fx <= 0 || k.fy <= 0 || k.width <= 0 || k.height <= 0) return 'The camera intrinsics are not usable.';
  return null;
}

/** Seconds from `now` to a scan's SLA; negative when overdue. Expedited scans are out of the regular SLA (null). */
export function scanSlaSecondsLeft(slaDueAt: string | Date | null, expedite: boolean, now: Date): number | null {
  if (expedite || slaDueAt === null) return null;
  return Math.round((new Date(slaDueAt).getTime() - now.getTime()) / 1000);
}

/** The scan statuses, in the order a scan moves through them. */
export const SCAN_STATUSES = ['processing', 'measured', 'needs_review', 'in_review', 'junior_done', 'visit_required'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];
/** Statuses where a person still has work to do on the scan. */
export const SCAN_OPEN_STATUSES = ['needs_review', 'in_review', 'junior_done'] as const;
export const SCAN_OUTCOMES = ['measured', 'visit_required'] as const;
export type ScanOutcome = (typeof SCAN_OUTCOMES)[number];

/** What the homeowner is told about a window's scan. */
export type HomeownerScanState = 'checking' | 'measured' | 'visit_required';
export const HOMEOWNER_SCAN_TEXT: Record<HomeownerScanState, string> = {
  checking: 'Being checked by WinChoice',
  measured: 'Measured',
  visit_required: 'We will measure this one at your free visit',
};
export function homeownerScanState(status: ScanStatus): HomeownerScanState {
  if (status === 'measured') return 'measured';
  if (status === 'visit_required') return 'visit_required';
  return 'checking';
}

/** One line of a scan's history (stored on the scan, shown to the reviewers). */
export const SCAN_HISTORY_ACTIONS = ['created', 'auto_accepted', 'marks_edited', 'submitted', 'finalized', 'expedited', 'unexpedited'] as const;
export type ScanHistoryAction = (typeof SCAN_HISTORY_ACTIONS)[number];
export type ScanHistoryEvent = {
  at: string;
  /** The staff user, or null for the system (the phone's upload, the automatic accept). */
  by: string | null;
  action: ScanHistoryAction;
  from?: ScanStatus;
  to?: ScanStatus;
  note?: string;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* The staff API's views (GET /api/window-scans, GET /api/window-scans/:id)                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ScanQueueItem = {
  id: string;
  status: ScanStatus;
  expedite: boolean;
  slaDueAt: string;
  /** Seconds to the SLA (negative: overdue); null for an expedited scan, which is out of the regular SLA. */
  secondsLeft: number | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
  windowId: string;
  room: string;
  label: string;
  address: string;
  /** The homeowner's name once they have filed their contact details. */
  homeowner: string | null;
  frameCount: number;
  /** The scan's first frame, for the row's picture (a same-origin URL, session auth). */
  thumbUrl: string | null;
  widthIn: number | null;
  heightIn: number | null;
  failed: ScanGateCode[];
  outcome: ScanOutcome | null;
};

export type ScanQueueView = { scans: ScanQueueItem[]; counts: Record<ScanStatus, number> };

export type ScanFrameView = ScanFrame & { imageUrl: string };

export type ScanReviewer = { id: string; name: string; at: string } | null;

export type ScanDetailView = {
  id: string;
  status: ScanStatus;
  expedite: boolean;
  slaDueAt: string;
  secondsLeft: number | null;
  overdue: boolean;
  createdAt: string;
  windowId: string;
  room: string;
  label: string;
  address: string;
  homeowner: string | null;
  app: string | null;
  device: string | null;
  frames: ScanFrameView[];
  marks: ScanMark[];
  /** The marks as the phone sent them. */
  marksOriginal: ScanMark[];
  wall: ScanWall | null;
  phoneResult: ScanResult | null;
  /** The server's result for the marks now. */
  result: ScanResult;
  junior: ScanReviewer;
  senior: ScanReviewer;
  outcome: ScanOutcome | null;
  outcomeReason: string | null;
  /** A senior finalised 'measured' with a gate failing. */
  overrode: boolean;
  history: (ScanHistoryEvent & { byName: string | null })[];
  /** The signed-in member may move marks now. */
  mayEdit: boolean;
  /** The signed-in member may finalise (a senior reviewer: owner or office). */
  mayFinalize: boolean;
};
