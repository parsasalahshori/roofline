import {
  SCAN_CORNERS,
  type ScanComputation,
  type ScanFrame,
  type ScanMark,
  type ScanRay,
  type ScanVec3,
  type ScanWall,
  computeScanResult,
  scanProject,
  scanRay,
  scanTriangulate,
} from './window-scan.ts';

/*
 * The server's refinement of a multi-frame scan (docs/windows/scan-contract.md, "Refinement"): COLMAP rebuilds the camera
 * poses from the photos, SAM 2 cuts the window out of every frame, and the corners are triangulated again, robustly, from
 * every candidate mark. This file is the pure part both the job and its tests run: no model, no process, no database.
 */

export const SCAN_REFINE_LIMITS = {
  /** COLMAP's poses are taken only when its model, aligned to ARKit's camera centres, is within this (RMS, cm)... */
  alignRmsCm: 2.0,
  /** ...and within this in the cameras' orientations (RMS, degrees: a turn round a line of camera centres hides in the centres)... */
  alignRotationDeg: 2.0,
  /** ...and at least this many photos were registered. */
  minRegistered: 4,
  /** An AI mark within this many pixels of the phone's mark for the same corner agrees with it (the AI mark is used). */
  agreePx: 8,
  /** A mark that lands further than this from its triangulated corner is thrown out, while three or more remain. */
  dropPx: 8,
  /** A mark within this many pixels votes for a hypothesis while the best one is searched for. */
  inlierPx: 4,
  /** Marks a corner keeps at the least. */
  minKeep: 3,
  /** The prompt box round the projected window: this share of its size on every side. */
  boxPad: 0.08,
  /** The AI's quad is used for marks only at or above this fit quality (0..1). */
  minAiQuality: 0.6,
  /** A prompt box less than this share inside the picture is a close-up of a corner, not a view of the window. */
  minVisibleShare: 0.5,
} as const;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Poses                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The frames with each refined pose in place of the phone's (frames without one keep ARKit's). */
export function scanEffectiveFrames<F extends ScanFrame>(frames: readonly F[], poses: Readonly<Record<string, readonly number[]>> | null | undefined): F[] {
  if (poses === null || poses === undefined) return [...frames];
  return frames.map((f) => {
    const p = poses[f.frameId];
    return p !== undefined && p.length === 16 ? { ...f, cameraTransform: [...p] } : f;
  });
}

export type ColmapOutcome = { registered: number; total: number; alignmentRmsCm: number | null; rotationRmsDeg: number | null };

/** Whether COLMAP's poses are good enough to replace ARKit's, and if not, why (a plain sentence for the reviewer). */
export function scanColmapDecision(o: ColmapOutcome): { use: boolean; reason: string | null } {
  const L = SCAN_REFINE_LIMITS;
  if (o.registered < L.minRegistered) return { use: false, reason: `COLMAP registered only ${o.registered} of ${o.total} photos (needs ${L.minRegistered}).` };
  if (o.alignmentRmsCm === null || !Number.isFinite(o.alignmentRmsCm)) return { use: false, reason: 'COLMAP did not line up with the phone.' };
  if (o.alignmentRmsCm >= L.alignRmsCm) return { use: false, reason: `COLMAP's cameras are ${o.alignmentRmsCm.toFixed(1)} cm off the phone's (limit ${L.alignRmsCm} cm).` };
  if (o.rotationRmsDeg !== null && Number.isFinite(o.rotationRmsDeg) && o.rotationRmsDeg >= L.alignRotationDeg) {
    return { use: false, reason: `COLMAP's cameras point ${o.rotationRmsDeg.toFixed(1)} degrees off the phone's (limit ${L.alignRotationDeg}).` };
  }
  return { use: true, reason: null };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The prompt for the AI on a frame                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ProjectedBox = {
  /** [x0, y0, x1, y1] in native pixels, padded and clamped to the picture. */
  box: [number, number, number, number];
  /** A positive point for the segmenter, inside the window, in the picture (native pixels). */
  point: [number, number];
  /** The four corners as projected (native pixels), before any clamping. */
  corners: [number, number][];
  /** The share of the padded box that is inside the picture (1 for a window in view, small for a close-up of a corner). */
  visibleShare: number;
};

/**
 * The window as a frame sees it: the four corners (the current triangulated rectangle) projected with the frame's pose, the
 * box round them padded by `pad`, the box's centre as the positive point. Null when a corner is behind the camera or the
 * window is out of the picture altogether.
 */
export function scanProjectedBox(cornersM: readonly ScanVec3[], frame: Pick<ScanFrame, 'cameraTransform' | 'intrinsics'>, pad: number = SCAN_REFINE_LIMITS.boxPad): ProjectedBox | null {
  if (cornersM.length !== 4) return null;
  const px: [number, number][] = [];
  for (const p of cornersM) {
    const q = scanProject(p, frame.cameraTransform, frame.intrinsics);
    if (q === null || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
    px.push(q);
  }
  const W = frame.intrinsics.width;
  const H = frame.intrinsics.height;
  const xs = px.map((p) => p[0]);
  const ys = px.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (!(bw > 1) || !(bh > 1)) return null;
  const full = [x0 - bw * pad, y0 - bh * pad, x1 + bw * pad, y1 + bh * pad] as const;
  const clamped: [number, number, number, number] = [Math.max(0, full[0]), Math.max(0, full[1]), Math.min(W, full[2]), Math.min(H, full[3])];
  const cw = clamped[2] - clamped[0];
  const ch = clamped[3] - clamped[1];
  if (!(cw > 4) || !(ch > 4)) return null;
  const visibleShare = (cw * ch) / ((full[2] - full[0]) * (full[3] - full[1]));
  // The window's centre when it is in the picture; otherwise a point inside the window nearest to the picture's middle
  let point: [number, number] = [(x0 + x1) / 2, (y0 + y1) / 2];
  if (point[0] < 0 || point[1] < 0 || point[0] > W || point[1] > H) {
    point = [Math.min(W, Math.max(0, point[0])), Math.min(H, Math.max(0, point[1]))];
    // pull the clamped point a little inside the clamped box
    point = [Math.min(clamped[2] - cw * 0.1, Math.max(clamped[0] + cw * 0.1, point[0])), Math.min(clamped[3] - ch * 0.1, Math.max(clamped[1] + ch * 0.1, point[1]))];
  }
  return { box: clamped, point, corners: px, visibleShare };
}

/**
 * A quad from the mask fit (TL, TR, BR, BL as the picture shows them, clockwise on the screen) put in the scan's corner order
 * (TL, TR, BR, BL as a person faces the window, upright against gravity). The phone is often held upright, so the native
 * landscape picture has the window on its side. With the window as the current estimate projects it (`projected`, in the
 * scan's order) the quad's corners are matched to it; without one, gravity decides.
 */
export function scanOrderQuad(quad: readonly (readonly [number, number])[], frame: Pick<ScanFrame, 'cameraTransform'>, projected?: readonly (readonly [number, number])[] | null): [number, number][] {
  const q = quad.map((p) => [p[0], p[1]] as [number, number]);
  if (q.length !== 4) return q;
  let shift = 0;
  if (projected !== undefined && projected !== null && projected.length === 4) {
    let best = Infinity;
    for (let k = 0; k < 4; k++) {
      let cost = 0;
      for (let i = 0; i < 4; i++) cost += (q[(i + k) % 4]![0] - projected[i]![0]) ** 2 + (q[(i + k) % 4]![1] - projected[i]![1]) ** 2;
      if (cost < best) {
        best = cost;
        shift = k;
      }
    }
  } else {
    // Gravity's "up" as the picture shows it: the world's +Y in the camera's frame, image y points down
    const up = scanMat4RotateTransposed(frame.cameraTransform, [0, 1, 0]);
    const ux = up[0];
    const uy = -up[1];
    const l = Math.hypot(ux, uy);
    if (l > 0.2) {
      const [vx, vy] = [ux / l, uy / l];
      const [rx, ry] = [-vy, vx];
      const cx = q.reduce((s, p) => s + p[0], 0) / 4;
      const cy = q.reduce((s, p) => s + p[1], 0) / 4;
      let best = -Infinity;
      for (let i = 0; i < 4; i++) {
        const dx = q[i]![0] - cx;
        const dy = q[i]![1] - cy;
        const score = dx * vx + dy * vy - (dx * rx + dy * ry);
        if (score > best) {
          best = score;
          shift = i;
        }
      }
    }
  }
  return [0, 1, 2, 3].map((i) => q[(i + shift) % 4]!);
}

/** Rᵀ d: a world direction in the camera's frame (the camera transform's rotation, transposed). */
function scanMat4RotateTransposed(m: readonly number[], d: ScanVec3): ScanVec3 {
  return [m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2], m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2], m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2]];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Candidate marks and the robust choice                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

const keyOf = (m: Pick<ScanMark, 'frameId' | 'corner'>): string => `${m.frameId}\u0000${m.corner}`;

/**
 * Combines the marks a scan already has (the phone's, and a reviewer's own) with the AI's. Per frame and corner: a reviewer's
 * mark stands alone; an AI mark that agrees with the phone's (within `agreePx`) replaces it; when they disagree both go on as
 * candidates (`alternatives` holds the second) and the robust triangulation picks; alone, either stands.
 */
export function mergeScanMarks(base: readonly ScanMark[], ai: readonly ScanMark[], agreePx: number = SCAN_REFINE_LIMITS.agreePx): { marks: ScanMark[]; alternatives: ScanMark[] } {
  const baseBy = new Map<string, ScanMark>();
  for (const m of base) if (Number.isFinite(m.x) && Number.isFinite(m.y)) baseBy.set(keyOf(m), m);
  const aiBy = new Map<string, ScanMark>();
  for (const m of ai) if (Number.isFinite(m.x) && Number.isFinite(m.y)) aiBy.set(keyOf(m), m);
  const marks: ScanMark[] = [];
  const alternatives: ScanMark[] = [];
  for (const key of new Set([...baseBy.keys(), ...aiBy.keys()])) {
    const b = baseBy.get(key);
    const a = aiBy.get(key);
    if (b !== undefined && (a === undefined || b.source === 'user')) marks.push(b);
    else if (b === undefined && a !== undefined) marks.push({ ...a, source: 'ai' });
    else if (b !== undefined && a !== undefined) {
      if (Math.hypot(a.x - b.x, a.y - b.y) <= agreePx) marks.push({ ...a, source: 'ai' });
      else {
        marks.push(b);
        alternatives.push({ ...a, source: 'ai' });
      }
    }
  }
  return { marks, alternatives };
}

export type RobustMarks = {
  /** One mark per (frame, corner) that is kept. */
  marks: ScanMark[];
  /** Marks thrown out for landing more than `dropPx` from their corner while three or more others remained. */
  dropped: ScanMark[];
  /** Candidates that lost to another candidate of the same frame and corner. */
  unused: ScanMark[];
};

type Cand = { mark: ScanMark; frame: ScanFrame; ray: ScanRay };

/**
 * Each corner triangulated from all its candidate marks, robustly. A candidate pair from two frames makes a hypothesis (the two
 * rays meet at a point); the point most frames agree with (their best candidate within `inlierPx`) wins. The corner is then
 * met again from the frames that agree with it, round and round, and a mark further than `dropPx` from the corner is thrown out
 * while at least `minKeep` remain. A reviewer's own marks (source 'user') are never thrown out.
 */
export function scanRobustMarks(frames: readonly ScanFrame[], candidates: readonly ScanMark[], opts: { inlierPx?: number; dropPx?: number; minKeep?: number } = {}): RobustMarks {
  const L = SCAN_REFINE_LIMITS;
  const inlierPx = opts.inlierPx ?? L.inlierPx;
  const dropPx = opts.dropPx ?? L.dropPx;
  const minKeep = opts.minKeep ?? L.minKeep;
  const frameById = new Map(frames.map((f) => [f.frameId, f]));
  const out: RobustMarks = { marks: [], dropped: [], unused: [] };

  for (const corner of SCAN_CORNERS) {
    const cands: Cand[] = [];
    for (const m of candidates) {
      if (m.corner !== corner || !Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      const frame = frameById.get(m.frameId);
      if (frame === undefined) continue;
      cands.push({ mark: m, frame, ray: scanRay(m.x, m.y, frame.cameraTransform, frame.intrinsics) });
    }
    const byFrame = new Map<string, Cand[]>();
    for (const c of cands) byFrame.set(c.frame.frameId, [...(byFrame.get(c.frame.frameId) ?? []), c]);
    const ids = [...byFrame.keys()];
    const errAt = (p: ScanVec3, c: Cand): number => {
      const q = scanProject(p, c.frame.cameraTransform, c.frame.intrinsics);
      return q === null ? Infinity : Math.hypot(q[0] - c.mark.x, q[1] - c.mark.y);
    };
    /** Each frame's candidate nearest to the point, with its error. */
    const nearest = (p: ScanVec3): Map<string, { cand: Cand; err: number }> => {
      const res = new Map<string, { cand: Cand; err: number }>();
      for (const id of ids) {
        let best: { cand: Cand; err: number } | null = null;
        for (const c of byFrame.get(id)!) {
          const e = errAt(p, c);
          if (best === null || e < best.err) best = { cand: c, err: e };
        }
        res.set(id, best!);
      }
      return res;
    };
    const keepAll = () => {
      for (const id of ids) {
        const list = byFrame.get(id)!;
        out.marks.push(list[0]!.mark);
        for (const extra of list.slice(1)) out.unused.push(extra.mark);
      }
    };
    if (ids.length < 2) {
      keepAll();
      continue;
    }

    // 1. The hypothesis most frames agree with
    let best: { p: ScanVec3; inliers: number; cost: number } | null = null;
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        if (cands[i]!.frame.frameId === cands[j]!.frame.frameId) continue;
        const p = scanTriangulate([cands[i]!.ray, cands[j]!.ray]);
        if (p === null) continue;
        let inliers = 0;
        let cost = 0;
        for (const { err } of nearest(p).values()) {
          if (err <= inlierPx) inliers++;
          cost += Math.min(err, inlierPx) ** 2;
        }
        if (best === null || inliers > best.inliers || (inliers === best.inliers && cost < best.cost)) best = { p, inliers, cost };
      }
    }
    if (best === null) {
      keepAll();
      continue;
    }

    // 2. Meet the corner from the frames that agree with it, again and again; throw out what stays far off
    let point = best.p;
    let chosen = new Map<string, Cand>();
    for (let round = 0; round < 6; round++) {
      const near = nearest(point);
      const agree = new Set<string>();
      for (const [id, { cand, err }] of near) if (err <= dropPx || cand.mark.source === 'user') agree.add(id);
      if (agree.size < Math.min(minKeep, ids.length)) {
        for (const [id] of [...near].sort((a, b) => a[1].err - b[1].err)) {
          agree.add(id);
          if (agree.size >= Math.min(minKeep, ids.length)) break;
        }
      }
      const next = new Map([...agree].map((id) => [id, near.get(id)!.cand] as const));
      // A reviewer's mark stays whatever it says, but one that is far off does not pull the corner towards it
      const fit = [...next.values()].filter((c) => c.mark.source !== 'user' || near.get(c.frame.frameId)!.err <= dropPx);
      const p = scanTriangulate((fit.length >= 2 ? fit : [...next.values()]).map((c) => c.ray));
      const same = next.size === chosen.size && [...next].every(([id, c]) => chosen.get(id) === c);
      chosen = next;
      if (p !== null) point = p;
      if (same) break;
    }
    for (const id of ids) {
      const picked = chosen.get(id);
      const list = byFrame.get(id)!;
      if (picked !== undefined) {
        out.marks.push(picked.mark);
        for (const c of list) if (c !== picked) out.unused.push(c.mark);
      } else {
        // thrown out: the candidate nearest to the corner is the one that is shown as dropped
        const nearestCand = nearest(point).get(id)!.cand;
        out.dropped.push(nearestCand.mark);
        for (const c of list) if (c !== nearestCand) out.unused.push(c.mark);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The refined result                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

export type RefinedScan = {
  comp: ScanComputation;
  /** The marks the result is worked out from (one per frame and corner). */
  marks: ScanMark[];
  dropped: ScanMark[];
  alternatives: ScanMark[];
};

/**
 * The scan worked out again with the (refined) frames: the phone's and the reviewer's marks and the AI's merged, each corner
 * triangulated robustly, then the level rectangle and the seven gates as ever (`computeScanResult`).
 */
export function computeRefinedScan(frames: readonly ScanFrame[], base: readonly ScanMark[], ai: readonly ScanMark[], wall: ScanWall | null): RefinedScan {
  const merged = mergeScanMarks(base, ai);
  const robust = scanRobustMarks(frames, [...merged.marks, ...merged.alternatives]);
  const comp = computeScanResult(frames, robust.marks, wall);
  return { comp, marks: robust.marks, dropped: robust.dropped, alternatives: robust.unused };
}
