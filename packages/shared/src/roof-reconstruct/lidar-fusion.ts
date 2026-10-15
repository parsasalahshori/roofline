// Lidar fusion: roof that leaf-off airborne lidar (USGS 3DEP) sees and Google's leaf-on height map does not. Under a
// tree crown Google's heights are the canopy and its roof mask stops at the crown, so a wing or a long eave under trees
// is simply missing from the reconstruction (about 15 % of the plan on canopy-heavy houses, docs/roof-3d/truth.md).
// Pulses flown in winter pass between bare branches and hit that roof. This step writes the lidar's roof surface into
// the height map and the mask ONLY where Google's heights are occluded there, and the reconstruction then runs as
// usual on the patched layers: the faces it fits on lidar pixels take their pitch from the lidar's surface, and Google's
// faces, pitch and edges are untouched wherever Google sees the roof. Design note: docs/roof-3d/fusion.md.
//
// Pure and deterministic; no randomness; it never throws (a typed reason instead) and refuses rather than guesses:
//  1. Gates: points present and within the size limit, flown leaf-off, not too old, dense enough on Google's roof.
//  2. Registration onto Google's frame (outline-lidar.ts register: inlier count on smooth height-map pixels), then the
//     lidar's roof returns must lie on Google's smooth roof (median 0.15 m) or the step declines ('misaligned').
//  3. Returns classified ground / roof (smooth raised planes, branches rejected: outline-lidar.ts classify), and per
//     height-map pixel a lidar surface: roof where roof returns dominate within a small radius, its height from a local
//     least-squares plane through them.
//  4. Change between the flight and Google's imagery is refused, not merged: Google roof the lidar sees as bare ground
//     (built since the flight), or lidar roof where Google sees smooth lower ground (taken down since), past a small
//     share each: reason 'changed'.
//  5. Lidar-only roof: lidar roof pixels off Google's roof part where Google's heights are occluded (a crown at least
//     0.5 m above the lidar roof, or no data), joined by the pixels where both agree (canopy gaps), opened so the eave
//     lip along visible edges does not count, then each connected part kept only when it touches Google's roof, is at
//     least minPartM2, and is mostly occluded (a part Google saw in full is not hidden roof, it is something else).
//  6. Added at most maxAddShare of Google's part ('large-change'), and nothing added at all: 'nothing-hidden'.
import type { RoofRaster } from './index.ts';
import { GROUND, ROOF, bucket, classify, type LidarCloud, median, register, smoothMap, type Win } from './outline-lidar.ts';
import { close, components, dilate, type Grid, open } from './raster.ts';

export type LidarFusionParams = {
  /** Fewer last returns than this per m2 of Google's roof is too sparse to draw roof from (QL2 is 2-4, QL1 8+). */
  minRoofDensity: number;
  /** Decline lidar older than this many years (the change check is the real guard; this bounds the work). */
  maxAgeYears: number;
  /** Decline lidar not known to be leaf-off (a leaf-on canopy hides the roof from lidar too). */
  requireLeafOff: boolean;
  /** Horizontal registration search radius, metres (median shift measured by the truth harness: 1.17 m). */
  searchM: number;
  /**
   * Room round Google's roof part searched for lidar-only roof, metres. A wing is one or two rooms deep (4-8 m); 12 m
   * holds the deepest dev case seen (a wing 7.6 m past Google's building box) with registration room.
   */
  windowM: number;
  /** Google's height this far above the lidar roof means a crown over it (occluded), metres: twice QL1's vertical RMSE plus the DSM's noise. */
  occludedM: number;
  /** Lidar roof this far above a SMOOTH Google surface: Google sees ground or a lower roof where the lidar saw roof, metres. */
  conflictM: number;
  /** Strips narrower than twice this are the eave lip along a visible edge (the height map's blur), not roof parts, metres. */
  openM: number;
  /** A lidar-only part smaller than this is not added, square metres (a roofing square is 9.3 m2; a bay window is about 2). */
  minPartM2: number;
  /** A part must be occluded on at least this share of its pixels (the rest: canopy gaps where Google sees it too). */
  minOccludedShare: number;
  /** A part must come within this of Google's roof part, metres (an attached wing; a detached roof is another building). */
  touchM: number;
  /**
   * All parts together at most this share of Google's part: the lidar may at most double the roof (an L or T house with
   * one arm under trees); more is likelier a neighbour joined through a crown or a wrong frame, and is refused.
   */
  maxAddShare: number;
  /** Change since the flight: Google's smooth roof the lidar sees as ground, at most this share of it. */
  maxGoneShare: number;
  /** Change since the flight: lidar roof touching the house where Google sees smooth lower ground, at most this, m2. */
  maxConflictM2: number;
  /** Size limit: at most this many points are read (a 70 m QL1 crop is about 150 000). */
  maxPoints: number;
};

/** Constants from the physics or the data spec, not fitted to a house; sensitivity +-20 % in docs/roof-3d/fusion.md. */
export const DEFAULT_LIDAR_FUSION: LidarFusionParams = {
  minRoofDensity: 4,
  maxAgeYears: 12,
  requireLeafOff: true,
  searchM: 3,
  windowM: 12,
  occludedM: 0.5,
  conflictM: 0.5,
  openM: 0.4,
  minPartM2: 4,
  minOccludedShare: 0.5,
  touchM: 1,
  maxAddShare: 1,
  maxGoneShare: 0.1,
  maxConflictM2: 6,
  maxPoints: 400_000,
};

export const LIDAR_FUSION_REASONS = [
  'no-points',
  'too-many-points',
  'not-leaf-off',
  'too-old',
  'no-roof',
  'sparse',
  'misaligned',
  'changed',
  'nothing-hidden',
  'large-change',
  'error',
] as const;
export type LidarFusionReason = (typeof LIDAR_FUSION_REASONS)[number];

export type LidarFusionReport = {
  applied: boolean;
  reason?: LidarFusionReason;
  /** The registration (lidar + shift = Google's frame), metres, and the roof returns' median distance to Google's smooth roof. */
  shift?: { dx: number; dy: number; dz: number; madM: number };
  /** Last returns per m2 on Google's roof. */
  roofDensity?: number;
  /** Google's smooth roof the lidar sees as bare ground (share), and lidar roof where Google sees lower smooth ground (m2). */
  goneShare?: number;
  conflictM2?: number;
  /** Lidar-only parts found (before the touch/size/occlusion tests) and added, and the pixels added, square metres. */
  candidates?: number;
  parts?: { areaM2: number; occludedShare: number }[];
  addedM2?: number;
};

export type LidarFusionResult = {
  /** The layers with the lidar's roof written in (the input itself when nothing was added). */
  raster: RoofRaster;
  /** 1 on whole-raster pixels whose height and roof membership came from the lidar; null when nothing was added. */
  lidarPx: Uint8Array | null;
  /**
   * For the outline's edge evidence only: the patched heights plus the lidar's bare ground under crowns within
   * EVIDENCE_GROUND_M of the added parts (groundPx marks those pixels). Absent when nothing was added.
   */
  evidence?: { dsm: Float32Array; groundPx: Uint8Array };
  report: LidarFusionReport;
};

/** Roof only the lidar sees, written into the layers; or the layers unchanged with the reason. Never throws. */
export function fuseLidar(raster: RoofRaster, point: { col: number; row: number }, cloud: LidarCloud, prm: LidarFusionParams = DEFAULT_LIDAR_FUSION, debug?: (msg: string) => void): LidarFusionResult {
  try {
    return run(raster, point, cloud, prm, debug);
  } catch {
    return { raster, lidarPx: null, report: { applied: false, reason: 'error' } };
  }
}

function run(raster: RoofRaster, point: { col: number; row: number }, cloud: LidarCloud, prm: LidarFusionParams, debug?: (msg: string) => void): LidarFusionResult {
  const keep = (reason: LidarFusionReason, extra: Partial<LidarFusionReport> = {}): LidarFusionResult => ({ raster, lidarPx: null, report: { applied: false, reason, ...extra } });
  const { width: W, height: H, pixelSizeM: s } = raster;
  const n = cloud.x.length;
  if (n === 0 || cloud.y.length !== n || cloud.z.length !== n || cloud.flags.length !== n) return keep('no-points');
  if (n > prm.maxPoints) return keep('too-many-points');
  if (prm.requireLeafOff && cloud.leafOff !== true) return keep('not-leaf-off');
  if (cloud.ageYears != null && cloud.ageYears > prm.maxAgeYears) return keep('too-old');
  if (!(W > 2 && H > 2 && s > 0) || raster.dsm.length !== W * H || raster.mask.length !== W * H) return keep('no-roof');

  // Google's roof part under the point (or the nearest within 12 m, as reconstructRoof finds it).
  const full: Grid = { w: W, h: H };
  const { labels } = components(full, (i) => raster.mask[i] !== 0);
  const pc = Math.min(W - 1, Math.max(0, Math.floor(point.col)));
  const pr = Math.min(H - 1, Math.max(0, Math.floor(point.row)));
  let part = labels[pr * W + pc]!;
  if (part === 0) {
    let best = 12 / s;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) continue;
      const c = i % W;
      const d = Math.hypot(c + 0.5 - point.col, (i - c) / W + 0.5 - point.row);
      if (d < best) {
        best = d;
        part = labels[i]!;
      }
    }
  }
  if (part === 0) return keep('no-roof');
  let pc0 = W, pr0 = H, pc1 = -1, pr1 = -1, partPx = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== part) continue;
    const c = i % W;
    const r = (i - c) / W;
    pc0 = Math.min(pc0, c); pc1 = Math.max(pc1, c); pr0 = Math.min(pr0, r); pr1 = Math.max(pr1, r);
    partPx++;
  }

  // The window: the part plus windowM round it, in whole-raster pixels.
  const m = Math.ceil(prm.windowM / s);
  const wc0 = Math.max(0, pc0 - m);
  const wr0 = Math.max(0, pr0 - m);
  const wc1 = Math.min(W - 1, pc1 + m);
  const wr1 = Math.min(H - 1, pr1 + m);
  const g: Grid = { w: wc1 - wc0 + 1, h: wr1 - wr0 + 1 };
  const win: Win = { c0: wc0, r0: wr0, w: g.w, h: g.h, dsm: new Float32Array(g.w * g.h) };
  const inPart = new Uint8Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const src = (r + wr0) * W + c + wc0;
      const z = raster.dsm[src]!;
      win.dsm[r * g.w + c] = Number.isFinite(z) && z > -1000 && z < 10000 ? z : Number.NaN;
      if (labels[src] === part) inPart[r * g.w + c] = 1;
    }
  }

  // Points in window metres (x east from the window's left edge, y north from its top edge), in their given order.
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const pf: number[] = [];
  const wx = g.w * s;
  const wy = g.h * s;
  for (let i = 0; i < n; i++) {
    const x = cloud.x[i]! - wc0 * s;
    const y = cloud.y[i]! + wr0 * s;
    const z = cloud.z[i]!;
    if (!(x >= -prm.searchM && x < wx + prm.searchM && y <= prm.searchM && y > -wy - prm.searchM && Number.isFinite(z))) continue;
    px.push(x);
    py.push(y);
    pz.push(z);
    pf.push(cloud.flags[i]!);
  }
  if (px.length < 50) return keep('no-points');

  // 1b. Density before the registration (a shift of a metre or two barely changes a count over the whole roof): a
  //     sparse cloud is declined without paying for the search.
  {
    let pre = 0;
    for (let i = 0; i < px.length; i++) {
      if ((pf[i]! & 1) === 0) continue;
      const c = Math.floor(px[i]! / s);
      const r = Math.floor(-py[i]! / s);
      if (c >= 0 && r >= 0 && c < g.w && r < g.h && inPart[r * g.w + c] === 1) pre++;
    }
    if (pre / (partPx * s * s) < PRE_DENSITY_SHARE * prm.minRoofDensity) return keep('sparse', { roofDensity: round(pre / (partPx * s * s), 2) });
  }

  // 2. Registration.
  const smooth = smoothMap(win, s);
  const reg = register(win, s, smooth, px, py, pz, pf, prm.searchM, debug, REG_BUDGET);
  if (reg === null) return keep('misaligned');
  const P = px.length;
  const qx = new Float64Array(P);
  const qy = new Float64Array(P);
  const qz = new Float64Array(P);
  for (let i = 0; i < P; i++) {
    qx[i] = px[i]! + reg.dx;
    qy[i] = py[i]! + reg.dy;
    qz[i] = pz[i]! + reg.dz;
  }
  const pixOf = (x: number, y: number): number => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
  };
  // Density and the on-roof check: last returns over Google's part; residuals on its smooth pixels only (under a crown
  // Google's heights are the canopy).
  let roofPts = 0;
  const resid: number[] = [];
  for (let i = 0; i < P; i++) {
    if ((pf[i]! & 1) === 0) continue;
    const k = pixOf(qx[i]!, qy[i]!);
    if (k < 0 || inPart[k] !== 1) continue;
    roofPts++;
    if (smooth[k] === 1) resid.push(Math.abs(qz[i]! - win.dsm[k]!));
  }
  const roofDensity = roofPts / (partPx * s * s);
  const madM = resid.length >= 50 ? median(resid) : Infinity;
  const shift = { dx: round(reg.dx, 3), dy: round(reg.dy, 3), dz: round(reg.dz, 3), madM: round(madM, 3) };
  const base: Partial<LidarFusionReport> = { shift, roofDensity: round(roofDensity, 2) };
  debug?.(`lidar fusion: ${roofPts} last returns on ${(partPx * s * s).toFixed(1)} m2 of Google's roof, MAD ${madM.toFixed(3)} m`);
  if (roofDensity < prm.minRoofDensity) return keep('sparse', base);
  if (!(madM <= REG_MAD_M)) return keep('misaligned', base);

  // 3. Classify, then a lidar surface per window pixel.
  const grid = bucket(qx, qy, 0.5);
  const cls = classify(qx, qy, qz, pf, grid, roofDensity);
  const radius = Math.max(MIN_RADIUS_M, RADIUS_SPACINGS / Math.sqrt(roofDensity));
  const r2 = radius * radius;
  const reach = Math.ceil(radius / grid.cell);
  const lidarZ = new Float32Array(g.w * g.h).fill(Number.NaN);
  const groundOnly = new Uint8Array(g.w * g.h);
  const groundZ = new Float32Array(g.w * g.h).fill(Number.NaN);
  // Only pixels within SURFACE_NEAR_M of a roof return, or on Google's part (the change check), need a surface.
  const roofCell = new Set<number>();
  for (let i = 0; i < P; i++) if (cls[i] === ROOF) roofCell.add(cellKey(Math.floor(qx[i]! / grid.cell), Math.floor(qy[i]! / grid.cell)));
  const nearReach = Math.ceil(SURFACE_NEAR_M / grid.cell);
  const nearRoof = new Set<number>();
  for (const key of roofCell) {
    const cc0 = Math.floor(key / 100_000) - 50_000;
    const rr0 = (key % 100_000) - 50_000;
    for (let dr = -nearReach; dr <= nearReach; dr++) for (let dc = -nearReach; dc <= nearReach; dc++) nearRoof.add(cellKey(cc0 + dc, rr0 + dr));
  }
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      if (inPart[r * g.w + c] !== 1 && !nearRoof.has(cellKey(Math.floor(((c + 0.5) * s) / grid.cell), Math.floor((-(r + 0.5) * s) / grid.cell)))) continue;
      const cx = (c + 0.5) * s;
      const cy = -(r + 0.5) * s;
      const gc = Math.floor(cx / grid.cell);
      const gr = Math.floor(cy / grid.cell);
      let nr = 0, ng = 0, gz = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
      for (let rr = gr - reach; rr <= gr + reach; rr++) {
        for (let cc = gc - reach; cc <= gc + reach; cc++) {
          const l = grid.map.get(cellKey(cc, rr));
          if (l === undefined) continue;
          for (const j of l) {
            const t = cls[j]!;
            if (t === 0) continue;
            const dx = qx[j]! - cx;
            const dy = qy[j]! - cy;
            if (dx * dx + dy * dy > r2) continue;
            if (t === GROUND) {
              ng++;
              gz += qz[j]!;
              continue;
            }
            const dz = qz[j]!;
            nr++; sx += dx; sy += dy; sz += dz; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz;
          }
        }
      }
      const k = r * g.w + c;
      if (nr === 0 && ng >= 2) {
        groundOnly[k] = 1;
        groundZ[k] = gz / ng;
      }
      if (nr < 2 || nr < ng) continue;
      // Least-squares plane through the roof returns, evaluated at the pixel centre (dx = dy = 0); their mean when the
      // returns do not pin a plane (two returns, or in a line).
      const mx = sx / nr, my = sy / nr, mz = sz / nr;
      const cxx = sxx / nr - mx * mx, cxy = sxy / nr - mx * my, cyy = syy / nr - my * my;
      const cxz = sxz / nr - mx * mz, cyz = syz / nr - my * mz;
      const det = cxx * cyy - cxy * cxy;
      let z = mz;
      if (nr >= 3 && det > 1e-6 * Math.max(1e-9, (cxx + cyy) * (cxx + cyy))) {
        const a = (cxz * cyy - cyz * cxy) / det;
        const b = (cyz * cxx - cxz * cxy) / det;
        if (Math.hypot(a, b) <= 2) z = mz - a * mx - b * my;
      }
      lidarZ[k] = z;
    }
  }

  // 3b. Ridges and hips: a return on a crest has neighbours on two planes, so classify leaves it unclassified and a
  //     strip about a neighbourhood wide along every crest has no roof surface. Gaps up to GAP_FILL_M wide between roof
  //     pixels are closed, their height the median of the non-ground last returns round them (none: left open).
  {
    const roofPx = new Uint8Array(g.w * g.h);
    for (let k = 0; k < roofPx.length; k++) if (Number.isFinite(lidarZ[k]!)) roofPx[k] = 1;
    const closed = close(g, roofPx, Math.max(1, Math.round(GAP_FILL_M / 2 / s)));
    const fr = radius * 1.5;
    const fr2 = fr * fr;
    const freach = Math.ceil(fr / grid.cell);
    for (let k = 0; k < roofPx.length; k++) {
      if (closed[k] !== 1 || roofPx[k] === 1) continue;
      const c = k % g.w;
      const r = (k - c) / g.w;
      const cx = (c + 0.5) * s;
      const cy = -(r + 0.5) * s;
      const gc = Math.floor(cx / grid.cell);
      const gr = Math.floor(cy / grid.cell);
      const zs: number[] = [];
      for (let rr = gr - freach; rr <= gr + freach; rr++) {
        for (let cc = gc - freach; cc <= gc + freach; cc++) {
          const l = grid.map.get(cellKey(cc, rr));
          if (l === undefined) continue;
          for (const j of l) {
            if ((pf[j]! & 1) === 0 || cls[j] === GROUND) continue;
            const dx = qx[j]! - cx;
            const dy = qy[j]! - cy;
            if (dx * dx + dy * dy <= fr2) zs.push(qz[j]!);
          }
        }
      }
      if (zs.length >= 2) lidarZ[k] = median(zs);
    }
  }

  // 4. Change since the flight.
  let smoothRoof = 0;
  let gone = 0;
  for (let k = 0; k < inPart.length; k++) {
    if (inPart[k] !== 1 || smooth[k] !== 1) continue;
    smoothRoof++;
    if (groundOnly[k] === 1) gone++;
  }
  const goneShare = smoothRoof > 0 ? gone / smoothRoof : 0;
  const near = dilate(g, inPart, Math.round(prm.touchM / s));
  // 5. Lidar-only roof: occluded, agreeing and conflicting pixels off Google's part.
  const occluded = new Uint8Array(g.w * g.h);
  const cand = new Uint8Array(g.w * g.h);
  const conflict = new Uint8Array(g.w * g.h);
  for (let k = 0; k < cand.length; k++) {
    if (inPart[k] === 1) continue;
    const zl = lidarZ[k]!;
    if (!Number.isFinite(zl)) continue;
    const zg = win.dsm[k]!;
    if (!Number.isFinite(zg) || zg - zl >= prm.occludedM) {
      occluded[k] = 1;
      cand[k] = 1;
    } else if (zl - zg >= prm.conflictM) {
      // Google sees a lower surface (ground, a lower roof) where the lidar saw roof. Its eave lip is opened away below.
      conflict[k] = 1;
    } else {
      cand[k] = 1;
    }
  }
  if (debug !== undefined) {
    let nl = 0, nc = 0, no = 0, nC = 0;
    for (let k = 0; k < cand.length; k++) { if (Number.isFinite(lidarZ[k]!) && inPart[k] !== 1) nl++; nc += cand[k]!; no += occluded[k]!; nC += conflict[k]!; }
    debug(`lidar fusion: off-part lidar roof ${(nl * s * s).toFixed(1)} m2, candidates ${(nc * s * s).toFixed(1)}, occluded ${(no * s * s).toFixed(1)}, conflict ${(nC * s * s).toFixed(1)}`);
  }
  const openR = Math.max(1, Math.round(prm.openM / s));
  const conflictOpen = open(g, conflict, openR);
  // Conflicting roof only counts where it is part of the house (touching Google's roof), not a neighbour's shed.
  const confLab = components(g, (i) => conflictOpen[i] === 1);
  const confTouch = new Set<number>();
  for (let k = 0; k < confLab.labels.length; k++) if (confLab.labels[k]! > 0 && near[k] === 1) confTouch.add(confLab.labels[k]!);
  let conflictPx = 0;
  for (let k = 0; k < confLab.labels.length; k++) if (confTouch.has(confLab.labels[k]!)) conflictPx++;
  const conflictM2 = conflictPx * s * s;
  const withChange = { ...base, goneShare: round(goneShare, 3), conflictM2: round(conflictM2, 2) };
  debug?.(`lidar fusion: change check gone ${(goneShare * 100).toFixed(1)}% of Google's smooth roof, conflict ${conflictM2.toFixed(1)} m2`);
  if (goneShare > prm.maxGoneShare || conflictM2 > prm.maxConflictM2) return keep('changed', withChange);

  const opened = open(g, cand, openR);
  const lab = components(g, (i) => opened[i] === 1);
  const nLab = lab.sizes.length;
  const touches = new Uint8Array(nLab + 1);
  const occ = new Int32Array(nLab + 1);
  const size = new Int32Array(nLab + 1);
  for (let k = 0; k < lab.labels.length; k++) {
    const L = lab.labels[k]!;
    if (L === 0) continue;
    size[L]!++;
    if (occluded[k] === 1) occ[L]!++;
    if (near[k] === 1) touches[L] = 1;
  }
  const minPx = prm.minPartM2 / (s * s);
  const take = new Uint8Array(nLab + 1);
  const parts: { areaM2: number; occludedShare: number }[] = [];
  let candidates = 0;
  let added = 0;
  for (let L = 1; L <= nLab; L++) {
    if (touches[L] !== 1 || size[L]! < minPx) continue;
    candidates++;
    const share = occ[L]! / size[L]!;
    debug?.(`lidar fusion: part ${L} ${(size[L]! * s * s).toFixed(1)} m2, occluded ${(share * 100).toFixed(0)}%`);
    if (share < prm.minOccludedShare) continue;
    take[L] = 1;
    added += size[L]!;
    parts.push({ areaM2: round(size[L]! * s * s, 2), occludedShare: round(share, 3) });
  }
  const report: LidarFusionReport = { applied: false, ...withChange, candidates, parts, addedM2: round(added * s * s, 2) };
  if (added === 0) return { raster, lidarPx: null, report: { ...report, reason: 'nothing-hidden' } };
  if (added > prm.maxAddShare * partPx) return { raster, lidarPx: null, report: { ...report, reason: 'large-change' } };

  // 6. Write the lidar's roof into copies of the layers.
  const dsm = raster.dsm.slice();
  const mask = raster.mask.slice();
  const green = raster.green != null && raster.green.length === W * H ? raster.green.slice() : raster.green;
  const lidarPx = new Uint8Array(W * H);
  for (let k = 0; k < lab.labels.length; k++) {
    if (take[lab.labels[k]!] !== 1) continue;
    const c = k % g.w;
    const r = (k - c) / g.w;
    const src = (r + wr0) * W + c + wc0;
    dsm[src] = lidarZ[k]!;
    mask[src] = 1;
    // The photo shows the crown here, not the roof: not a tree pixel for the reconstruction's crown test.
    if (green != null) green[src] = 0;
    lidarPx[src] = 1;
  }
  // For the edge evidence only (never the reconstruction): the lidar's bare ground under the crown just outside the
  // added parts, so an eave the lidar placed is judged by the drop the lidar measured, not by the canopy beside it.
  const evidenceDsm = dsm.slice();
  const groundPx = new Uint8Array(W * H);
  const addedW = new Uint8Array(g.w * g.h);
  for (let k = 0; k < addedW.length; k++) if (take[lab.labels[k]!] === 1) addedW[k] = 1;
  const besideAdded = dilate(g, addedW, Math.round(EVIDENCE_GROUND_M / s));
  for (let k = 0; k < besideAdded.length; k++) {
    if (besideAdded[k] !== 1 || addedW[k] === 1 || inPart[k] === 1 || groundOnly[k] !== 1) continue;
    const zg = win.dsm[k]!;
    if (Number.isFinite(zg) && zg - groundZ[k]! < prm.occludedM) continue;
    const c = k % g.w;
    const r = (k - c) / g.w;
    const src = (r + wr0) * W + c + wc0;
    evidenceDsm[src] = groundZ[k]!;
    groundPx[src] = 1;
  }
  return { raster: { ...raster, dsm, mask, green: green ?? null }, lidarPx, evidence: { dsm: evidenceDsm, groundPx }, report: { ...report, applied: true } };
}

/**
 * The density gate before registration is this share of minRoofDensity: the unregistered count can be short by the
 * part of the roof a 1-2 m shift moves off it; the exact gate follows the registration.
 */
const PRE_DENSITY_SHARE = 0.8;
/** Returns used by the registration search (coarse, fine): the prototype's coarse search, half its fine one (a house window has 15 000 last returns or more). */
const REG_BUDGET = { coarse: 8000, fine: 15000 };
/** The lidar's roof returns must lie on Google's smooth roof: median absolute distance at most this, metres. */
const REG_MAD_M = 0.15;
/** The lidar surface at a pixel is read from returns within this radius: at least MIN_RADIUS_M, else about RADIUS_SPACINGS point spacings. */
const MIN_RADIUS_M = 0.35;
const RADIUS_SPACINGS = 1.2;
/** The lidar's ground is written into the edge-evidence heights this far round the added parts (eave support reads 1 m out), metres. */
const EVIDENCE_GROUND_M = 1.5;
/** A surface is worked out only this close to a roof return (the evidence ground reaches 1.5 m past the roof), metres. */
const SURFACE_NEAR_M = 2;
/** Crest strips up to this wide between lidar roof pixels are filled (classify's neighbourhood is about 1.2 m across), metres. */
const GAP_FILL_M = 1;
const cellKey = (c: number, r: number) => (c + 50_000) * 100_000 + (r + 50_000);

function round(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

