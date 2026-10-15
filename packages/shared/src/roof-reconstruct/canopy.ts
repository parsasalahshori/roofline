// Tree canopy and the roof it hides, from the height map (and the photo's green when there is one). Pure and
// deterministic (no random numbers). Two jobs:
//
// 1. A crown map: where foliage stands. Photo-green above the ground, OR a tall non-planar blob off every roof mask
//    (a plane through 0.8 m of heights leaves CROWN_RMS_M or more). The photo rule alone misses shaded and autumn
//    foliage (29% recall on geometric crowns in the failure taxonomy); the geometric rule does not care about colour.
// 2. Roof completion: roof the mask missed but the heights still show. Grown out of the roof's own faces along their
//    own planes ('grown': smooth heights on the face's plane, in Google's box, a part at least GROW_WIDE_M across, so
//    the blurred rim at every eave is not taken), and across notches that a crown bites out of one roof line ('bridged':
//    roof on both sides of the bite along the house's own axes, nothing between them that drops like an eave). A
//    bridged pixel is not measured: it is inferred, and reported as occluded.
//
// Nothing here grows past evidence: a pixel lower than the face's plane by an eave drop stops the growth, and no
// pixel of another mask part (a neighbour's roof) is ever taken. See docs/roof-3d/canopy.md.
import type { XY } from './geom.ts';
import { components, dilate, type Grid, type Mask, open } from './raster.ts';

/** z = a x + b y + c in the grid's metres (x east from the left edge, y north from the top edge, so y <= 0). */
type Plane = { a: number; b: number; c: number };

export type CanopyParams = {
  /** Photo-green pixels this high above the ground are foliage (lawn and shrubs are lower), metres. */
  greenAboveM: number;
  /** Geometric crown: this high above the ground (a roof's eave is usually higher, but it is planar), metres. */
  crownAboveM: number;
  /** ...and the RMS of the heights about a plane fitted over a (2 crownHalfM)^2 window at least this, metres. */
  crownRmsM: number;
  crownHalfM: number;
  /** ...opened by this radius (a crown is a blob, not a rough line along a wall or fence), metres... */
  crownOpenM: number;
  /** ...in parts at least this big, square metres. */
  crownMinM2: number;
  /** Growth: a pixel on the face's plane within this, metres. */
  growTolM: number;
  /** ...with heights smooth: plane RMS over a (2 crownHalfM)^2 window under this, metres. */
  growRmsM: number;
  /** ...in parts this wide (an opening of half of it) and this big, so a blurred eave rim never grows. */
  growWideM: number;
  growMinM2: number;
  /** ...at most this far from the roof, metres. */
  growMaxM: number;
  /** A grown part's outer edge (off crowns) must drop by eaveDropM along at least eaveShare of it (strong eave support). */
  eaveDropM: number;
  eaveShare: number;
  /** Bridging: a notch at most this long along the house's axis, metres. */
  bridgeMaxM: number;
  /** ...in which no pixel is lower than the face's plane by more than this (an eave drop: the ground is visible), metres. */
  bridgeDropM: number;
  /** ...whose filled part is at least this big (smaller notches are pixel noise the outline squares away), square metres. */
  bridgeMinM2: number;
  /** Google's box (when given) plus this, metres: no roof is completed outside it. */
  boxMarginM: number;
};

export const DEFAULT_CANOPY_PARAMS: CanopyParams = {
  // The failure taxonomy's crown definition (section 1.2), as stated there.
  greenAboveM: 1.0,
  crownAboveM: 1.5,
  crownRmsM: 0.08,
  crownHalfM: 0.4,
  crownOpenM: 0.5,
  crownMinM2: 3,
  // 0.15 m: the plane fit's own tolerance is 0.10 m on pixels it was fitted to; extrapolated a metre or two the plane's
  // error grows (0.01 m of slope error a metre), and shaded heights are noisier.
  growTolM: 0.15,
  // Half the crown's roughness: a roof face in a 0.1 m height map has an RMS of 2-4 cm about its plane.
  growRmsM: 0.05,
  // A height map's eave blur is 0.3-0.5 m wide; a wing or a bay worth measuring is at least a metre across.
  growWideM: 1.0,
  growMinM2: 2,
  growMaxM: 6,
  // The taxonomy's 'strong' eave support (median 0.2-0.5 m inside minus median 0.6-1.0 m outside >= 1 m), required
  // along most of the part's open edge.
  eaveDropM: 1.0,
  eaveShare: 0.5,
  // A crown overhanging an eave bites a notch about as wide as the part of the crown over the roof. 3 m holds a large
  // branch's bite; 5 m (a whole crown) was measured too: tree houses' OSM overlap rose on 6 of 7 but the dev gates
  // failed (low-slope outline IoU -0.005, and jagged completed edges sent 4 more roofs' topology to pixel faces).
  bridgeMaxM: 3,
  // The eave-support rule of the failure taxonomy: under 0.5 m of drop the edge is not supported by the heights.
  bridgeDropM: 0.5,
  bridgeMinM2: 0.5,
  boxMarginM: 1,
};

/**
 * The RMS of the heights about a least-squares plane over each pixel's (2k+1)^2 window, metres (NaN where the window
 * leaves the grid or holds a missing height). O(pixels) with summed-area tables: over a full, centred window the
 * plane's slopes decouple (sum of dx z / sum of dx^2, the same in y).
 */
export function localPlaneRms(g: Grid, dsm: Float32Array, k: number): Float32Array {
  const { w, h } = g;
  const W = w + 1;
  const S = new Float64Array(W * (h + 1));
  const SX = new Float64Array(W * (h + 1));
  const SY = new Float64Array(W * (h + 1));
  const SZZ = new Float64Array(W * (h + 1));
  const SN = new Float64Array(W * (h + 1));
  // Heights less their mean keep the sums well conditioned (absolute heights are tens to hundreds of metres).
  let off = 0;
  let cnt = 0;
  for (let i = 0; i < w * h; i++) if (Number.isFinite(dsm[i]!)) {
    off += dsm[i]!;
    cnt++;
  }
  off = cnt > 0 ? off / cnt : 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const z0 = dsm[r * w + c]!;
      const ok = Number.isFinite(z0);
      const z = ok ? z0 - off : 0;
      const j = (r + 1) * W + c + 1;
      const add = (T: Float64Array, v: number) => (T[j] = v + T[j - 1]! + T[j - W]! - T[j - W - 1]!);
      add(S, z);
      add(SX, c * z);
      add(SY, r * z);
      add(SZZ, z * z);
      add(SN, ok ? 0 : 1);
    }
  }
  const box = (T: Float64Array, c0: number, r0: number, c1: number, r1: number) => T[r1 * W + c1]! - T[r0 * W + c1]! - T[r1 * W + c0]! + T[r0 * W + c0]!;
  const n = (2 * k + 1) ** 2;
  // Sum of dx^2 over the window (the same for dy).
  let sxx = 0;
  for (let d = -k; d <= k; d++) sxx += d * d * (2 * k + 1);
  const out = new Float32Array(w * h).fill(Number.NaN);
  for (let r = k; r < h - k; r++) {
    for (let c = k; c < w - k; c++) {
      const c0 = c - k;
      const r0 = r - k;
      const c1 = c + k + 1;
      const r1 = r + k + 1;
      if (box(SN, c0, r0, c1, r1) > 0) continue;
      const sz = box(S, c0, r0, c1, r1);
      const szz = box(SZZ, c0, r0, c1, r1);
      const mz = sz / n;
      const varZ = szz / n - mz * mz;
      const sxz = box(SX, c0, r0, c1, r1) - c * sz;
      const syz = box(SY, c0, r0, c1, r1) - r * sz;
      const v = varZ - (sxz * sxz + syz * syz) / (sxx * n);
      out[r * w + c] = Math.sqrt(Math.max(0, v));
    }
  }
  return out;
}

/**
 * Tree crowns on a grid: photo-green and greenAboveM above the ground, or (whatever the colour) crownAboveM above the
 * ground, non-planar (localPlaneRms at least crownRmsM) and off every roof mask, opened by crownOpenM, in parts of
 * crownMinM2 or more. `hag` is each pixel's height above the ground (NaN unknown); without it there is no crown map.
 */
export function crownMap(g: Grid, s: number, dsm: Float32Array, anyMask: Mask, green: Mask | null, hag: Float32Array | null, prm: CanopyParams = DEFAULT_CANOPY_PARAMS): Mask {
  const n = g.w * g.h;
  const out = new Uint8Array(n);
  if (hag === null || hag.length !== n) return out;
  const rms = localPlaneRms(g, dsm, Math.max(1, Math.round(prm.crownHalfM / s)));
  const geo = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (anyMask[i] !== 1 && hag[i]! > prm.crownAboveM && rms[i]! >= prm.crownRmsM) geo[i] = 1;
  const opened = open(g, geo, Math.max(1, Math.round(prm.crownOpenM / s)));
  const { labels, sizes } = components(g, (i) => opened[i] === 1);
  const minPx = prm.crownMinM2 / (s * s);
  for (let i = 0; i < n; i++) {
    if (labels[i]! > 0 && sizes[labels[i]!]! >= minPx) out[i] = 1;
    else if (green?.[i] === 1 && hag[i]! > prm.greenAboveM) out[i] = 1;
  }
  return out;
}

export type Completion = {
  /** 0 = unchanged, 1 = grown (the heights show roof on the face's plane), 2 = bridged (inferred under a crown). */
  added: Uint8Array;
  /** Face (index into `planes`) each added pixel continues. */
  face: Int32Array;
  grownM2: number;
  bridgedM2: number;
};

/**
 * Roof the mask missed (see the file comment). `roof` and `labels` (face per roof pixel, -1 none) on grid `g`;
 * `planes` in the grid's metres; `anyMask` every mask part (none is ever taken); `axis` the house's main direction
 * (radians); `box` Google's box round the building (grid metres) or null (then nothing is completed: without it there
 * is no bound on what a plane's extension might sweep up). Null when nothing is added.
 */
export function completeRoof(
  g: Grid,
  s: number,
  dsm: Float32Array,
  roof: Mask,
  labels: Int32Array,
  planes: readonly Plane[],
  anyMask: Mask,
  crown: Mask,
  box: readonly XY[] | null,
  axis: number,
  prm: CanopyParams = DEFAULT_CANOPY_PARAMS,
): Completion | null {
  if (box === null || box.length < 3) return null;
  const { w, h } = g;
  const n = w * h;
  const at = (i: number) => ({ x: ((i % w) + 0.5) * s, y: -(Math.floor(i / w) + 0.5) * s });
  const resid = (i: number, k: number) => {
    const p = planes[k]!;
    const q = at(i);
    return dsm[i]! - (p.a * q.x + p.b * q.y + p.c);
  };
  // Inside the box plus its margin (the box is north-up: its x and y bounds).
  const xs = box.map((p) => p.x);
  const ys = box.map((p) => p.y);
  const bx0 = Math.min(...xs) - prm.boxMarginM;
  const bx1 = Math.max(...xs) + prm.boxMarginM;
  const by0 = Math.min(...ys) - prm.boxMarginM;
  const by1 = Math.max(...ys) + prm.boxMarginM;
  const inBox = (i: number) => {
    const q = at(i);
    return q.x >= bx0 && q.x <= bx1 && q.y >= by0 && q.y <= by1;
  };
  const free = (i: number) => roof[i] !== 1 && anyMask[i] !== 1 && Number.isFinite(dsm[i]!) && inBox(i);

  // Every pixel's nearest face (city-block flood from the labelled roof), for the plane a pixel would continue.
  const near = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  let queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (roof[i] === 1 && labels[i]! >= 0) {
      near[i] = labels[i]!;
      dist[i] = 0;
      queue.push(i);
    }
  }
  const maxSteps = Math.ceil(Math.max(prm.growMaxM, prm.bridgeMaxM) / s);
  for (let d = 0; d < maxSteps && queue.length > 0; d++) {
    const next: number[] = [];
    for (const i of queue) {
      const c = i % w;
      for (const j of [c > 0 ? i - 1 : -1, c < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= n || dist[j]! >= 0) continue;
        dist[j] = d + 1;
        near[j] = near[i]!;
        next.push(j);
      }
    }
    queue = next;
  }

  // 1. Grown: smooth heights on the nearest face's plane, connected to the roof through such pixels.
  const rms = localPlaneRms(g, dsm, Math.max(1, Math.round(prm.crownHalfM / s)));
  const growMax = Math.ceil(prm.growMaxM / s);
  const onPlane = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = near[i]!;
    if (k < 0 || dist[i]! > growMax || !free(i) || crown[i] === 1) continue;
    if (Math.abs(resid(i, k)) <= prm.growTolM && rms[i]! < prm.growRmsM) onPlane[i] = 1;
  }
  // Wide parts only: the eave's blurred rim (on the plane for a few pixels) is opened away.
  const wide = open(g, onPlane, Math.max(1, Math.round(prm.growWideM / 2 / s)));
  const touch = dilate(g, roof, 1);
  // An opened part touches the roof only through the rim the opening removed: it keeps the on-plane pixels within the
  // opening's reach of it (that joins it to the roof), and nothing further along the rim.
  const reach = dilate(g, wide, Math.max(1, Math.round(prm.growWideM / 2 / s)) + 1);
  const grownParts = components(g, (i) => onPlane[i] === 1);
  const touchesRoof = new Uint8Array(grownParts.sizes.length);
  for (let i = 0; i < n; i++) if (grownParts.labels[i]! > 0 && touch[i] === 1) touchesRoof[grownParts.labels[i]!] = 1;
  const added = new Uint8Array(n);
  const minGrow = prm.growMinM2 / (s * s);
  // Wide parts within an on-plane component that touches the roof, plus the on-plane pixels joining them to it.
  const wideIn = new Map<number, number>();
  for (let i = 0; i < n; i++) if (wide[i] === 1) wideIn.set(grownParts.labels[i]!, (wideIn.get(grownParts.labels[i]!) ?? 0) + 1);
  for (let i = 0; i < n; i++) {
    const l = grownParts.labels[i]!;
    if (l === 0 || touchesRoof[l] !== 1 || (wideIn.get(l) ?? 0) < minGrow) continue;
    // The rim pixels of such a component stay out unless they lie near its wide part (within the opening's radius).
    if (wide[i] === 1 || reach[i] === 1) added[i] = 1;
  }
  // A grown part must end in an eave: where its outer edge is not against a crown, the heights must drop by
  // eaveDropM. In a roof's own shadow a height map is interpolated (smooth, on the roof's plane for a metre or two, then
  // fading to the ground with no drop): that is not roof, and without this test it grows (the failure taxonomy, mode 4).
  const ended = eaveEnded(g, s, dsm, roof, added, crown, prm);
  for (let i = 0; i < n; i++) if (added[i] === 1 && ended[i] !== 1) added[i] = 0;

  // 2. Bridged: notches along the house's axes, roof (or grown roof) on both sides within bridgeMaxM, nothing between
  //    showing an eave drop below the nearest face's plane, at least one crown pixel among them.
  const isRoof = (i: number) => roof[i] === 1 || added[i] === 1;
  const dirs: XY[] = [
    { x: Math.cos(axis), y: Math.sin(axis) },
    { x: -Math.sin(axis), y: Math.cos(axis) },
  ];
  const steps = Math.ceil(prm.bridgeMaxM / (s * 0.5));
  const occl = (i: number) => {
    const k = near[i]!;
    return k >= 0 && free(i) && resid(i, k) >= -prm.bridgeDropM;
  };
  const toIdx = (x: number, y: number) => {
    const c = Math.floor(x / s);
    const r = Math.floor(-y / s);
    return c < 0 || r < 0 || c >= w || r >= h ? -1 : r * w + c;
  };
  const bridged = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (isRoof(i) || !occl(i) || dist[i]! > Math.ceil(prm.bridgeMaxM / s)) continue;
    const p = at(i);
    for (const d of dirs) {
      let ok = true;
      let crowned = crown[i] === 1;
      let span = 0;
      for (const sign of [1, -1]) {
        let hit = false;
        for (let t = 1; t <= steps; t++) {
          const j = toIdx(p.x + sign * d.x * t * s * 0.5, p.y + sign * d.y * t * s * 0.5);
          if (j < 0) break;
          if (isRoof(j)) {
            hit = true;
            span += t * s * 0.5;
            break;
          }
          if (!occl(j)) break;
          if (crown[j] === 1) crowned = true;
        }
        if (!hit) {
          ok = false;
          break;
        }
      }
      if (ok && crowned && span <= prm.bridgeMaxM) {
        bridged[i] = 1;
        break;
      }
    }
  }
  const bparts = components(g, (i) => bridged[i] === 1);
  const minBridge = prm.bridgeMinM2 / (s * s);
  for (let i = 0; i < n; i++) if (bparts.labels[i]! > 0 && bparts.sizes[bparts.labels[i]!]! >= minBridge) added[i] = 2;

  let grown = 0;
  let bridgedPx = 0;
  const face = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (added[i] === 0) continue;
    face[i] = near[i]!;
    if (added[i] === 1) grown++;
    else bridgedPx++;
  }
  if (grown + bridgedPx === 0) return null;
  return { added, face, grownM2: grown * s * s, bridgedM2: bridgedPx * s * s };
}

/**
 * The grown pixels (`added` === 1) in parts whose outer edge ends in an eave: of the edge pixels whose outside (0.6-1.0 m out, along the axis the edge faces) is not crown, at least eaveShare
 * have a drop (median 0.2-0.5 m inside less median 0.6-1.0 m outside) of eaveDropM or more. A part whose whole open edge
 * is against crowns passes (nothing contradicts it; its edge is occluded).
 */
function eaveEnded(g: Grid, s: number, dsm: Float32Array, roof: Mask, added: Uint8Array, crown: Mask, prm: CanopyParams): Mask {
  const { w, h } = g;
  const n = w * h;
  const parts = components(g, (i) => added[i] === 1);
  const inside = (i: number) => roof[i] === 1 || added[i] === 1;
  const sup = new Map<number, number>();
  const all = new Map<number, number>();
  const med = (v: number[]) => {
    const f = v.filter(Number.isFinite).sort((a, b) => a - b);
    return f.length === 0 ? Number.NaN : f[Math.floor(f.length / 2)]!;
  };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  for (let i = 0; i < n; i++) {
    const l = parts.labels[i]!;
    if (l === 0) continue;
    const c = i % w;
    const r = Math.floor(i / w);
    // An edge pixel's drop: the largest over the eight directions that leave the roof at once (the one most nearly
    // square to the edge, whatever the edge's angle to the grid); against a crown it is not counted.
    let best = -Infinity;
    let edge = false;
    let crowned = false;
    for (const [dc, dr] of DIRS) {
      const cc = c + dc;
      const rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= w || rr >= h || inside(rr * w + cc)) continue;
      edge = true;
      const step = Math.hypot(dc, dr) * s;
      const zin: number[] = [];
      const zout: number[] = [];
      for (let t = Math.max(1, Math.round(0.2 / step)); t <= Math.max(1, Math.round(0.5 / step)); t++) {
        const c2 = c - dc * t;
        const r2 = r - dr * t;
        if (c2 >= 0 && r2 >= 0 && c2 < w && r2 < h) zin.push(dsm[r2 * w + c2]!);
      }
      for (let t = Math.max(1, Math.round(0.6 / step)); t <= Math.max(1, Math.round(1.0 / step)); t++) {
        const c2 = c + dc * t;
        const r2 = r + dr * t;
        if (c2 < 0 || r2 < 0 || c2 >= w || r2 >= h) continue;
        if (crown[r2 * w + c2] === 1) crowned = true;
        zout.push(dsm[r2 * w + c2]!);
      }
      const drop = med(zin) - med(zout);
      if (drop > best) best = drop;
    }
    if (!edge || crowned) continue;
    all.set(l, (all.get(l) ?? 0) + 1);
    if (best >= prm.eaveDropM) sup.set(l, (sup.get(l) ?? 0) + 1);
  }
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = parts.labels[i]!;
    if (l === 0) continue;
    const a = all.get(l) ?? 0;
    if (a === 0 || (sup.get(l) ?? 0) >= prm.eaveShare * a) keep[i] = 1;
  }
  return keep;
}
