// Real roof geometry from a height map (Google Solar's Data Layers: a digital surface model and a roof mask, 0.1 m or
// 0.25 m a pixel). Pure and deterministic (a seeded random number generator); the server runs it, the web never does.
//
// 1. The roof: the mask's part under (or nearest) the point, small gaps closed and holes filled; cut down to this
//    home when it runs on into the buildings it touches (a terrace) past Google's box for the building.
// 2. Planes: sequential RANSAC with local candidates (10 cm tolerance, at most 24/12, at least 2 m2), every roof
//    pixel then given to the plane it fits best by a flood from the planes' own pixels; touching faces whose planes
//    agree are merged, small pieces in the roof's middle are dissolved into their neighbours (planes.ts).
// 3. The outline: the roof's pixel boundary, simplified and squared to the house (outline.ts).
// 4. Topology: corners where faces meet, creases as straight plane intersections between corners, steps where the
//    planes are far apart in height, eaves and rakes along the outline (topology.ts).
import type { LngLat } from '../roof.ts';
import type { Roof3d, Roof3dLineKind, RoofQuality, RoofQualityReason } from '../roof-3d.ts';
import { dist, nearestOnSegment, pointInRing, signedArea, simplifyClosedIdx, type XY } from './geom.ts';
import { DEFAULT_OUTLINE_PARAMS, mainAxis, maskBoundary, type OutlineParams, squareOutline } from './outline.ts';
import { buildFaces, DEFAULT_PLANE_PARAMS, dissolve, findPlanes, type Plane, type PlaneParams, refitFaces } from './planes.ts';
import { groundPlane, heightAboveGround, planeInCrop } from './ground.ts';
import { close, components, countSet, dilate, fillHoles, largestComponent, open, open3, seededRandom, squaredDistance } from './raster.ts';
import { buildTopology, DEFAULT_TOPOLOGY_PARAMS, type TopologyParams } from './topology.ts';

export { lngLatToUtm, utmToLngLat, utmZoneOfEpsg, type UtmZone } from './utm.ts';
export type { XY } from './geom.ts';
export type { Plane } from './planes.ts';

/** A height map and roof mask on one grid: row-major, row 0 at the top (north), `pixelSizeM` metres a pixel. */
export type RoofRaster = {
  width: number;
  height: number;
  pixelSizeM: number;
  /** Heights, metres; NaN where there is no data. */
  dsm: Float32Array;
  /** Non-zero where Google sees roof. */
  mask: Uint8Array;
  /**
   * Optional: 1 where the aerial photo is green (vegetation), on the same grid. Green pixels on rough heights are tree
   * crowns: no plane is fitted on them, and small steep faces by them are dropped.
   */
  green?: Uint8Array | null;
};

export type ReconstructOptions = {
  seed?: number;
  /** The roof must come within this many metres of the point. */
  maxPointDistM?: number;
  /** A roof smaller than this (square metres) is not a building worth measuring. */
  minRoofM2?: number;
  planes?: Partial<PlaneParams>;
  outline?: Partial<OutlineParams>;
  topology?: Partial<TopologyParams>;
  /** Development only: told what the topology decided. */
  debug?: (msg: string) => void;
  /** The imagery's quality (HIGH, MEDIUM), for the quality result. */
  imageryQuality?: string | null;
  /**
   * Google's box round the building at the point, its corners in pixel columns and rows (fractional), when known. A
   * mask part running well past it (a terrace or a semi-detached pair: the mask does not split buildings that touch)
   * is cut down to this home, and the roof marked for review ('joined-buildings').
   */
  building?: readonly { col: number; row: number }[];
};

/** Raster-local metres: x east from the raster's left edge, y north from its top edge (so y <= 0). */
export type LocalFace = {
  ring: XY[];
  plane: Plane;
  pitchX12: number;
  azimuthDeg: number;
  planAreaM2: number;
  slopedAreaM2: number;
  flat: boolean;
  label: XY;
};
export type LocalLine = { kind: Roof3dLineKind; a: XY; b: XY; faces: number[]; lengthM: number; riseM: number };
/** `clipped`: the roof runs off the height map's edge, so part of it is missing. */
export type LocalRoof = {
  outline: XY[];
  faces: LocalFace[];
  lines: LocalLine[];
  pixelSizeM: number;
  maskAreaM2: number;
  clipped: boolean;
  quality: RoofQuality;
};

const FLAT_X12 = 2;
/** A mask part with more than this share of its pixels over JOINED_NEAR_M outside the building's box is joined. */
const JOINED_SHARE = 0.15;
const JOINED_NEAR_M = 1;
/** How far a terrace home's own face may reach past the party wall worked out from the box, metres. */
const TERRACE_SNAP_M = 0.7;
const TERRACE_ON_PLANE_M = 0.25;
/** Mask parts lower than this above the ground (metres) and at least GROUND_PART_M2 big lie on it: not roof. */
const GROUND_M = 1.5;
const GROUND_PART_M2 = 2;
const GROUND_PART_WIDE_M = 0.6;
const GROUND_MAX_SHARE = 0.4;
/** Roof hidden from the mask (see crownEdgeShare, hiddenRoofShare). */
const CROWN_PROBE_M = [0.6, 1, 1.5];
const HIDDEN_MIN_HAG_M = 2.2;
const HIDDEN_WIDE_M = 0.8;
const HIDDEN_STEP_M = 0.2;
const HIDDEN_ROOM_M = 3;
const HIDDEN_NEAR_M = 1;
const HIDDEN_PART_M2 = 5;
/** A low attachment (see lowAttachment). */
const LOW_FLAT_X12 = 2.5;
const LOW_SHARE = 0.03;
const LOW_MAX_SHARE = 0.25;
const LOW_ABOVE_M = 0.2;
const LOW_OVER_LOWEST_M = 0.5;
const SQ_FT_PER_SQ_M = 10.7639104167;
const FT_PER_M = 3.280839895;

/** Compass direction a plane faces (downhill), degrees: 0 north, 90 east. */
export function azimuthOf(p: Plane): number {
  const deg = (Math.atan2(-p.a, -p.b) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/**
 * The roof under (or nearest) `point` (pixel column and row, fractional), reconstructed. Null when no roof part comes
 * within maxPointDistM of the point, the roof is too small, or no plane is found.
 */
export function reconstructRoof(raster: RoofRaster, point: { col: number; row: number }, opts: ReconstructOptions = {}): LocalRoof | null {
  const { width: W, height: H, pixelSizeM: s } = raster;
  if (!(W > 2 && H > 2 && s > 0) || raster.dsm.length !== W * H || raster.mask.length !== W * H) return null;
  const planePrm: PlaneParams = { ...DEFAULT_PLANE_PARAMS, ...opts.planes };
  const outlinePrm: OutlineParams = { ...DEFAULT_OUTLINE_PARAMS, ...opts.outline };
  const topoPrm: TopologyParams = { ...DEFAULT_TOPOLOGY_PARAMS, ...opts.topology };
  const rng = seededRandom(opts.seed ?? 7);

  // 1. The mask's part under the point, or the nearest one within reach.
  const full = { w: W, h: H };
  const { labels } = components(full, (i) => raster.mask[i] !== 0);
  const pc = Math.min(W - 1, Math.max(0, Math.floor(point.col)));
  const pr = Math.min(H - 1, Math.max(0, Math.floor(point.row)));
  let part = labels[pr * W + pc]!;
  if (part === 0) {
    let best = (opts.maxPointDistM ?? 12) / s;
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 0) continue;
      const c = i % W;
      const r = (i - c) / W;
      const d = Math.hypot(c + 0.5 - point.col, r + 0.5 - point.row);
      if (d < best) {
        best = d;
        part = labels[i]!;
      }
    }
  }
  if (part === 0) return null;
  let c0 = W;
  let r0 = H;
  let c1 = -1;
  let r1 = -1;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== part) continue;
    const c = i % W;
    const r = (i - c) / W;
    c0 = Math.min(c0, c);
    c1 = Math.max(c1, c);
    r0 = Math.min(r0, r);
    r1 = Math.max(r1, r);
  }
  let clipped = c0 <= 1 || r0 <= 1 || c1 >= W - 2 || r1 >= H - 2;
  const closeR = Math.max(1, Math.round(0.3 / s));
  const pad = closeR + 3;
  c0 = Math.max(0, c0 - pad);
  r0 = Math.max(0, r0 - pad);
  c1 = Math.min(W - 1, c1 + pad);
  r1 = Math.min(H - 1, r1 + pad);
  const g = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const dsm = new Float32Array(g.w * g.h);
  let roof: Uint8Array = new Uint8Array(g.w * g.h);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const src = (r + r0) * W + c + c0;
      const z = raster.dsm[src]!;
      dsm[r * g.w + c] = Number.isFinite(z) && z > -1000 && z < 10000 ? z : Number.NaN;
      roof[r * g.w + c] = labels[src] === part ? 1 : 0;
    }
  }
  // Google's own mask of this roof, as it came: what the outline is checked against.
  const googleMask = roof.slice();
  roof = fillHoles(g, largestComponent(g, open3(g, fillHoles(g, close(g, roof, closeR)))));
  let roofPx = countSet(roof);
  if (roofPx * s * s < (opts.minRoofM2 ?? 15)) return null;

  // Tree crowns: green in the photo and rough in the heights (a green roof is smooth).
  let tree: Uint8Array | null = null;
  if (raster.green != null && raster.green.length === W * H) {
    tree = new Uint8Array(g.w * g.h);
    for (let r = 1; r < g.h - 1; r++) {
      for (let c = 1; c < g.w - 1; c++) {
        const i = r * g.w + c;
        if (raster.green[(r + r0) * W + c + c0] !== 1) continue;
        // Height roughness: the largest second difference round the pixel.
        const z = dsm[i]!;
        const lap = Math.abs(4 * z - dsm[i - 1]! - dsm[i + 1]! - dsm[i - g.w]! - dsm[i + g.w]!);
        if (!(lap < 0.12)) tree[i] = 1;
      }
    }
    // A crown is more than its rough pixels: close the gaps between them.
    tree = close(g, tree, Math.max(1, Math.round(0.3 / s)));
    for (let i = 0; i < tree.length; i++) if (roof[i] !== 1) tree[i] = 0;
  }

  // 1a. The ground round the roof (a plane under the pixels next to it on no roof). Parts of the mask lying on it (a
  //     patio, a drive, a parked car: under GROUND_M above it) are not roof.
  const groundFull = groundPlane(full, s, raster.dsm, (i) => labels[i] === part, raster.mask, raster.green ?? null, { c0, r0, c1, r1 });
  const hag = groundFull === null ? null : heightAboveGround(g, s, dsm, planeInCrop(groundFull, s, c0, r0));
  if (hag !== null) {
    const gone = groundParts(g, s, roof, hag);
    if (gone !== null) {
      for (let i = 0; i < roof.length; i++) {
        if (gone[i] !== 1) continue;
        roof[i] = 0;
        googleMask[i] = 0;
      }
      roof = fillHoles(g, largestComponent(g, open3(g, fillHoles(g, close(g, roof, closeR)))));
      roofPx = countSet(roof);
      if (roofPx * s * s < (opts.minRoofM2 ?? 15)) return null;
      if (tree !== null) for (let i = 0; i < tree.length; i++) if (roof[i] !== 1) tree[i] = 0;
    }
  }

  // 1b. A part running on well past Google's box for the building at the point (a terrace, a semi-detached pair):
  //     this home is cut out of it (homeInTerrace).
  let joined = false;
  const box0 = opts.building !== undefined && opts.building.length >= 3 ? opts.building.map((p) => ({ x: (p.col - c0) * s, y: -(p.row - r0) * s })) : null;
  if (box0 !== null) {
    const box = box0;
    const near = nearRing(g, s, box, JOINED_NEAR_M);
    let outside = 0;
    for (let i = 0; i < roof.length; i++) if (roof[i] === 1 && near[i] !== 1) outside++;
    if (outside > JOINED_SHARE * roofPx) {
      joined = true;
      const found0 = findPlanes(g, s, dsm, roof, rng, planePrm, tree);
      const faces0 = found0.length > 0 ? buildFaces(g, s, dsm, roof, found0, planePrm, tree) : null;
      const mine = homeInTerrace(g, s, dsm, roof, box, faces0);
      for (let i = 0; i < roof.length; i++) if (mine[i] !== 1) googleMask[i] = 0;
      roof = fillHoles(g, largestComponent(g, open3(g, fillHoles(g, close(g, mine, closeR)))));
      roofPx = countSet(roof);
      if (roofPx * s * s < (opts.minRoofM2 ?? 15)) return null;
      if (tree !== null) for (let i = 0; i < tree.length; i++) if (roof[i] !== 1) tree[i] = 0;
      // Running off the height map's edge is now a question of what was kept.
      clipped = false;
      for (let i = 0; i < roof.length && !clipped; i++) {
        if (roof[i] !== 1) continue;
        const c = (i % g.w) + c0;
        const r = Math.floor(i / g.w) + r0;
        clipped = c <= 1 || r <= 1 || c >= W - 2 || r >= H - 2;
      }
    }
  }

  // 2. Planes and faces.
  const found = findPlanes(g, s, dsm, roof, rng, planePrm, tree);
  if (found.length === 0) return null;
  let faces = buildFaces(g, s, dsm, roof, found, planePrm, tree);
  if (faces.planes.length === 0) return null;
  let planes = refitFaces(g, s, dsm, faces, planePrm.tolM, planePrm.maxPitchX12);

  // 3. The outline, squared.
  const boundary = maskBoundary(g, roof, s);
  const outline = squareOutline(boundary, outlinePrm);
  if (outline.length < 3) return null;

  // 4. Topology. A face whose polygon comes out under the smallest face size (its corners pulled in by its
  //    neighbours' creases) is dissolved and the topology built again.
  let topo = buildTopology(g, s, faces.labels, planes, outline, dsm, topoPrm, opts.debug);
  for (let pass = 0; pass < 3 && faces.planes.length > 1; pass++) {
    const tiny = new Set(topo.faces.map((f, k) => (Math.abs(signedArea(f.ring)) < planePrm.tinyFaceM2 ? k : -1)).filter((k) => k >= 0));
    if (tiny.size === 0 || tiny.size >= faces.planes.length) break;
    faces = dissolve(g, s, dsm, roof, faces, tiny, tree);
    planes = refitFaces(g, s, dsm, faces, planePrm.tolM, planePrm.maxPitchX12);
    topo = buildTopology(g, s, faces.labels, planes, outline, dsm, topoPrm, opts.debug);
  }

  // Face areas: the polygons' (they tile the outline), shared out so they add up to the outline's area.
  const outlineArea = signedArea(outline);
  const pixelCount = new Array<number>(planes.length).fill(0);
  for (let i = 0; i < faces.labels.length; i++) if (faces.labels[i]! >= 0) pixelCount[faces.labels[i]!]!++;
  const raw = topo.faces.map((f, k) => (f.areaM2 > 0 ? f.areaM2 : pixelCount[k]! * s * s));
  const rawSum = raw.reduce((t, a) => t + a, 0);
  const scale = rawSum > 0 ? outlineArea / rawSum : 1;

  const quality = qualityOf(g, s, dsm, googleMask, roof, tree, faces.labels, planes, outline, topo.faces, opts.imageryQuality ?? null);
  if (joined) quality.reasons.push('joined-buildings');
  // Roof the height map's mask may have missed: crowns along the outline as high as its edge, or (inside Google's box
  // for the building) smooth raised ground off every mask next to the roof, a wing in a crown's shadow. Looked for on
  // a window holding the roof with room round it, and the box (which can reach past the mask's part).
  const hiddenWin = windowRound(raster, { c0, r0, c1, r1 }, opts.building);
  const toWin = (p: XY): XY => ({ x: p.x + (c0 - hiddenWin.c0) * s, y: p.y - (r0 - hiddenWin.r0) * s });
  const roofW = new Uint8Array(hiddenWin.g.w * hiddenWin.g.h);
  for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) roofW[(r + r0 - hiddenWin.r0) * hiddenWin.g.w + c + c0 - hiddenWin.c0] = roof[r * g.w + c]!;
  const crownEdge = crownEdgeShare(hiddenWin.g, s, hiddenWin.dsm, outline.map(toWin), hiddenWin.mask, hiddenWin.green);
  let hidden = 0;
  if (groundFull !== null && opts.building !== undefined && opts.building.length >= 3 && !joined) {
    const hagW = heightAboveGround(hiddenWin.g, s, hiddenWin.dsm, planeInCrop(groundFull, s, hiddenWin.c0, hiddenWin.r0));
    const boxW = opts.building.map((p) => ({ x: (p.col - hiddenWin.c0) * s, y: -(p.row - hiddenWin.r0) * s }));
    hidden = hiddenRoofShare(hiddenWin.g, s, hiddenWin.dsm, roofW, hiddenWin.mask, hiddenWin.green, hagW, boxW);
  }
  opts.debug?.(`crowns along ${(crownEdge * 100).toFixed(0)}% of the outline; raised smooth ground in the box ${(hidden * 100).toFixed(0)}% of the roof`);
  if (crownEdge >= QUALITY_LIMITS.crownEdgeShare || hidden >= QUALITY_LIMITS.hiddenShare) quality.reasons.push('roof-hidden');
  // A flat part at the outline no higher than the eaves of the roof it adjoins: a porch roof, a patio cover or a deck.
  if (lowAttachment(g, s, dsm, roof, faces.labels, planes, outlineArea)) quality.reasons.push('low-attachment');

  // Shift from the crop back to the whole raster.
  const ox = c0 * s;
  const oy = -r0 * s;
  const shift = (p: XY): XY => ({ x: p.x + ox, y: p.y + oy });
  const localFaces: LocalFace[] = planes.map((p0, k) => {
    // The plane in whole-raster coordinates: z = a (x - ox) + b (y - oy) + c.
    const plane: Plane = { a: p0.a, b: p0.b, c: p0.c - p0.a * ox - p0.b * oy };
    const slope = Math.hypot(plane.a, plane.b);
    const plan = raw[k]! * scale;
    return {
      ring: topo.faces[k]!.ring.map(shift),
      plane,
      pitchX12: slope * 12,
      azimuthDeg: azimuthOf(plane),
      planAreaM2: plan,
      slopedAreaM2: plan * Math.sqrt(1 + slope * slope),
      flat: slope * 12 < FLAT_X12,
      label: shift(labelPoint(g, s, faces.labels, k, topo.faces[k]!.ring)),
    };
  });
  // Largest first (ties: west to east, then north to south), with the lines' face numbers following.
  const order = localFaces.map((_, k) => k).sort((a, b) => {
    const fa = localFaces[a]!;
    const fb = localFaces[b]!;
    return fb.planAreaM2 - fa.planAreaM2 || fa.label.x - fb.label.x || fb.label.y - fa.label.y;
  });
  const newIndex = new Array<number>(order.length);
  order.forEach((k, i) => (newIndex[k] = i));
  return {
    outline: outline.map(shift),
    faces: order.map((k) => localFaces[k]!),
    lines: topo.lines.map((l) => ({ ...l, a: shift(l.a), b: shift(l.b), faces: l.faces.map((f) => newIndex[f]!) })),
    pixelSizeM: s,
    maskAreaM2: roofPx * s * s,
    clipped,
    quality,
  };
}

/**
 * The roof's pixels lying on the ground (a patio, a drive, a parked car the mask took for roof): parts under GROUND_M
 * above the ground at least GROUND_PART_M2 in size and GROUND_PART_WIDE_M across, with the low pixels along their
 * edges. Null when there are none, or when they would be GROUND_MAX_SHARE of the roof or more (then the ground is
 * not what was found: a home on a slope, a roof at the ground's height).
 */
function groundParts(g: { w: number; h: number }, s: number, roof: Uint8Array, hag: Float32Array): Uint8Array | null {
  const low = new Uint8Array(roof.length);
  let roofPx = 0;
  for (let i = 0; i < roof.length; i++) {
    if (roof[i] !== 1) continue;
    roofPx++;
    if (hag[i]! < GROUND_M) low[i] = 1;
  }
  // Thin rims (an eave's heights blurred down towards the ground) are not parts.
  const wide = Math.max(1, Math.round(GROUND_PART_WIDE_M / 2 / s));
  const parts = open(g, low, wide);
  const { labels, sizes } = components(g, (i) => parts[i] === 1);
  const big = new Uint8Array(roof.length);
  let n = 0;
  for (let i = 0; i < roof.length; i++) {
    if (labels[i]! > 0 && sizes[labels[i]!]! * s * s >= GROUND_PART_M2) {
      big[i] = 1;
      n++;
    }
  }
  if (n === 0 || n >= GROUND_MAX_SHARE * roofPx) return null;
  const near = dilate(g, big, wide + 1);
  const out = new Uint8Array(roof.length);
  for (let i = 0; i < roof.length; i++) if (low[i] === 1 && near[i] === 1) out[i] = 1;
  return out;
}

/**
 * The raster round a crop (`crop`, pixel columns and rows, inclusive) with HIDDEN_ROOM_M more all round, and round
 * Google's box (pixel corners) when given: its grid, origin, heights (NaN where missing), any-roof mask and photo green.
 */
function windowRound(
  raster: RoofRaster,
  crop: { c0: number; r0: number; c1: number; r1: number },
  box: readonly { col: number; row: number }[] | undefined,
): { g: { w: number; h: number }; c0: number; r0: number; dsm: Float32Array; mask: Uint8Array; green: Uint8Array | null } {
  const { width: W, height: H, pixelSizeM: s } = raster;
  const room = Math.ceil(HIDDEN_ROOM_M / s);
  const cols = [crop.c0 - room, crop.c1 + room, ...(box ?? []).map((p) => p.col - room), ...(box ?? []).map((p) => p.col + room)];
  const rows = [crop.r0 - room, crop.r1 + room, ...(box ?? []).map((p) => p.row - room), ...(box ?? []).map((p) => p.row + room)];
  const c0 = Math.max(0, Math.floor(Math.min(...cols)));
  const r0 = Math.max(0, Math.floor(Math.min(...rows)));
  const c1 = Math.min(W - 1, Math.ceil(Math.max(...cols)));
  const r1 = Math.min(H - 1, Math.ceil(Math.max(...rows)));
  const g = { w: c1 - c0 + 1, h: r1 - r0 + 1 };
  const dsm = new Float32Array(g.w * g.h);
  const mask = new Uint8Array(g.w * g.h);
  const green = raster.green != null && raster.green.length === W * H ? new Uint8Array(g.w * g.h) : null;
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const src = (r + r0) * W + c + c0;
      const k = r * g.w + c;
      const z = raster.dsm[src]!;
      dsm[k] = Number.isFinite(z) && z > -1000 && z < 10000 ? z : Number.NaN;
      mask[k] = raster.mask[src] !== 0 ? 1 : 0;
      if (green !== null) green[k] = raster.green![src] === 1 ? 1 : 0;
    }
  }
  return { g, c0, r0, dsm, mask, green };
}

/** Height roughness at a pixel: the absolute second difference of its four neighbours `k` pixels off (Infinity off the grid). */
function lapAt(g: { w: number; h: number }, dsm: Float32Array, i: number, k = 1): number {
  const c = i % g.w;
  const r = Math.floor(i / g.w);
  if (c < k || c >= g.w - k || r < k || r >= g.h - k) return Infinity;
  const v = Math.abs(4 * dsm[i]! - dsm[i - k]! - dsm[i + k]! - dsm[i - k * g.w]! - dsm[i + k * g.w]!);
  return Number.isNaN(v) ? Infinity : v;
}

/** Heights averaged over each pixel's (2r+1)^2 window (missing heights left out; NaN where all are). */
function boxMean(g: { w: number; h: number }, dsm: Float32Array, r: number): Float32Array {
  const out = new Float32Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= g.h || xx >= g.w) continue;
          const z = dsm[yy * g.w + xx]!;
          if (!Number.isFinite(z)) continue;
          sum += z;
          n++;
        }
      }
      out[y * g.w + x] = n > 0 ? sum / n : Number.NaN;
    }
  }
  return out;
}

/** Share of each pixel's (2r+1)^2 window that is set, on a grid. */
function windowShare(g: { w: number; h: number }, m: Uint8Array, r: number): Float32Array {
  const { w, h } = g;
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sum[(y + 1) * (w + 1) + x + 1] = m[y * w + x]! + sum[y * (w + 1) + x + 1]! + sum[(y + 1) * (w + 1) + x]! - sum[y * (w + 1) + x]!;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      const n = sum[y1 * (w + 1) + x1]! - sum[y0 * (w + 1) + x1]! - sum[y1 * (w + 1) + x0]! + sum[y0 * (w + 1) + x0]!;
      out[y * w + x] = n / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/**
 * Share of the outline's length along which tree crowns stand next to it as high as its edge: at two of the points
 * CROWN_PROBE_M outside it, a pixel on no roof, green in the photo, no lower than the roof 0.4 m inside less 0.3 m.
 * Such crowns hide whatever roof runs on under them (a wing, a garage). 0 without a photo.
 */
function crownEdgeShare(g: { w: number; h: number }, s: number, dsm: Float32Array, outline: readonly XY[], anyMask: Uint8Array, green: Uint8Array | null): number {
  if (green === null) return 0;
  const at = (p: XY) => {
    const c = Math.floor(p.x / s);
    const r = Math.floor(-p.y / s);
    return c < 0 || r < 0 || c >= g.w || r >= g.h ? -1 : r * g.w + c;
  };
  const ccw = signedArea(outline) > 0;
  let all = 0;
  let hit = 0;
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k]!;
    const b = outline[(k + 1) % outline.length]!;
    const len = dist(a, b);
    if (len < 0.1) continue;
    const d = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    // Outward normal: to the right of a counter-clockwise ring.
    const out = ccw ? { x: d.y, y: -d.x } : { x: -d.y, y: d.x };
    for (let t = 0.1; t < len; t += 0.2) {
      all++;
      const p = { x: a.x + d.x * t, y: a.y + d.y * t };
      const inside = at({ x: p.x - out.x * 0.4, y: p.y - out.y * 0.4 });
      const zin = inside >= 0 ? dsm[inside]! : Number.NaN;
      if (!Number.isFinite(zin)) continue;
      let crowns = 0;
      for (const m of CROWN_PROBE_M) {
        const j = at({ x: p.x + out.x * m, y: p.y + out.y * m });
        if (j < 0 || anyMask[j] === 1 || !(dsm[j]! > zin - 0.3)) continue;
        if (green[j] === 1) crowns++;
      }
      if (crowns >= 2) hit++;
    }
  }
  return all > 0 ? hit / all : 0;
}

/**
 * Raised smooth ground off every mask next to the roof inside Google's box for the building (plus JOINED_NEAR_M), as a
 * share of the roof: at least HIDDEN_MIN_HAG_M above the ground, not green, hardly rough, in parts HIDDEN_WIDE_M
 * across and HIDDEN_PART_M2 big that come within HIDDEN_NEAR_M of the roof. Roof the mask left out, most often in a crown's
 * shadow (the photo is dark there, so not green).
 */
function hiddenRoofShare(
  g: { w: number; h: number },
  s: number,
  dsm: Float32Array,
  roof: Uint8Array,
  anyMask: Uint8Array,
  green: Uint8Array | null,
  hag: Float32Array,
  box: readonly XY[],
): number {
  const n = g.w * g.h;
  const inBox = nearRing(g, s, box, JOINED_NEAR_M);
  // Rough: the second difference over HIDDEN_STEP_M of the heights averaged over 5 x 5 pixels (so a height map's
  // pixel noise is not), over 0.08 m.
  const smooth = boxMean(g, dsm, 2);
  const step = Math.max(1, Math.round(HIDDEN_STEP_M / s));
  const roughPx = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (lapAt(g, smooth, i, step) > 0.08) roughPx[i] = 1;
  const rough = windowShare(g, roughPx, Math.max(1, Math.round(0.2 / s)));
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (inBox[i] === 1 && anyMask[i] === 0 && roof[i] === 0 && hag[i]! >= HIDDEN_MIN_HAG_M && green?.[i] !== 1 && rough[i]! < 0.1) cand[i] = 1;
  }
  const wide = open(g, cand, Math.max(1, Math.round(HIDDEN_WIDE_M / 2 / s)));
  const near = dilate(g, roof, Math.max(1, Math.round(HIDDEN_NEAR_M / s)));
  const { labels, sizes } = components(g, (i) => wide[i] === 1);
  const touching = new Set<number>();
  for (let i = 0; i < n; i++) if (labels[i]! > 0 && near[i] === 1) touching.add(labels[i]!);
  let px = 0;
  let roofPx = 0;
  for (let i = 0; i < n; i++) {
    if (roof[i] === 1) roofPx++;
    const l = labels[i]!;
    if (l > 0 && touching.has(l) && sizes[l]! * s * s >= HIDDEN_PART_M2) px++;
  }
  return roofPx > 0 ? px / roofPx : 0;
}

/**
 * Whether a flat face (under LOW_FLAT_X12) of LOW_SHARE to LOW_MAX_SHARE of the roof lies along the outline with its
 * top (the 90th percentile of its heights) no more than LOW_ABOVE_M over the eaves (5th percentile of the heights) of
 * the sloped faces within 1.5 m of it, nor LOW_OVER_LOWEST_M over the lowest eaves of the whole roof: a porch roof, a patio cover or a
 * deck against the house, which a measurer may or may not count. (A flat roof between taller roofs is not one.)
 */
function lowAttachment(
  g: { w: number; h: number },
  s: number,
  dsm: Float32Array,
  roof: Uint8Array,
  labels: Int32Array,
  planes: readonly Plane[],
  roofAreaM2: number,
): boolean {
  const n = g.w * g.h;
  const pct = (v: number[], q: number) => {
    v.sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor(q * v.length))]!;
  };
  const sloped = planes.map((p) => Math.hypot(p.a, p.b) * 12 >= 3);
  const all: number[] = [];
  for (let i = 0; i < n; i++) if (labels[i]! >= 0 && sloped[labels[i]!] && Number.isFinite(dsm[i]!)) all.push(dsm[i]!);
  if (all.length < 20) return false;
  const lowest = pct(all, 0.05);
  const edge2 = (0.3 / s) ** 2;
  const offRoof = squaredDistance(g, (i) => roof[i] !== 1);
  for (let k = 0; k < planes.length; k++) {
    if (Math.hypot(planes[k]!.a, planes[k]!.b) * 12 >= LOW_FLAT_X12) continue;
    const zs: number[] = [];
    let onEdge = false;
    for (let i = 0; i < n; i++) {
      if (labels[i] !== k) continue;
      if (Number.isFinite(dsm[i]!)) zs.push(dsm[i]!);
      if (offRoof[i]! <= edge2) onEdge = true;
    }
    const share = (zs.length * s * s) / roofAreaM2;
    if (!onEdge || share < LOW_SHARE || share > LOW_MAX_SHARE) continue;
    const near = squaredDistance(g, (i) => labels[i] === k);
    const adj: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = labels[i]!;
      if (j < 0 || j === k || !sloped[j] || near[i]! > (1.5 / s) ** 2 || !Number.isFinite(dsm[i]!)) continue;
      adj.push(dsm[i]!);
    }
    if (adj.length < 20) continue;
    const top = pct(zs, 0.9);
    if (top <= pct(adj, 0.05) + LOW_ABOVE_M && top <= lowest + LOW_OVER_LOWEST_M) return true;
  }
  return false;
}

/** Other roofs offered with the main one (see otherRoofParts). */
export const OTHER_ROOFS = { minM2: 15, maxM2: 75, maxGapM: 12, maxShareOfMain: 0.5, max: 3 } as const;

/**
 * Other parts of the mask near a reconstructed roof (raster-local metres, as reconstructRoof gives it): detached
 * garages, sheds and carports. Each part that does not overlap the roof's outline, is at least OTHER_ROOFS.minM2, at
 * most OTHER_ROOFS.maxM2 (a two-car garage) and OTHER_ROOFS.maxShareOfMain of the roof's mask area (bigger is most
 * likely a neighbour's house) and
 * within OTHER_ROOFS.maxGapM of the outline, and nearer it than any such bigger part (a neighbour's outbuilding is
 * nearer the neighbour's house); nearest first, at most OTHER_ROOFS.max. `at` is a pixel inside the part
 * (column and row, for reconstructRoof), `gapM` its gap from the outline.
 */
export function otherRoofParts(raster: RoofRaster, main: LocalRoof): { at: { col: number; row: number }; areaM2: number; gapM: number }[] {
  const { width: W, height: H, pixelSizeM: s } = raster;
  const full = { w: W, h: H };
  const inMain = new Uint8Array(W * H);
  rasterize(full, s, main.outline, inMain);
  const { labels, sizes } = components(full, (i) => raster.mask[i] !== 0);
  const overlapping = new Set<number>();
  for (let i = 0; i < labels.length; i++) if (inMain[i] === 1 && labels[i]! > 0) overlapping.add(labels[i]!);
  const maxM2 = Math.min(OTHER_ROOFS.maxM2, OTHER_ROOFS.maxShareOfMain * main.maskAreaM2);
  const d2 = squaredDistance(full, (i) => inMain[i] === 1);
  // The other houses: parts too big to be an outbuilding.
  const houses = squaredDistance(full, (i) => labels[i]! > 0 && !overlapping.has(labels[i]!) && sizes[labels[i]!]! * s * s > maxM2);
  const best = new Map<number, { i: number; d2: number; house2: number }>();
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]!;
    if (l === 0 || overlapping.has(l)) continue;
    const area = sizes[l]! * s * s;
    if (area < OTHER_ROOFS.minM2 || area > maxM2) continue;
    const b = best.get(l);
    if (b === undefined) best.set(l, { i, d2: d2[i]!, house2: houses[i]! });
    else {
      if (d2[i]! < b.d2) {
        b.i = i;
        b.d2 = d2[i]!;
      }
      b.house2 = Math.min(b.house2, houses[i]!);
    }
  }
  const out: { at: { col: number; row: number }; areaM2: number; gapM: number }[] = [];
  for (const [l, b] of best) {
    const gapM = Math.sqrt(b.d2) * s;
    // Too far, or nearer another house (whose outbuilding it most likely is).
    if (gapM > OTHER_ROOFS.maxGapM || b.house2 <= b.d2) continue;
    // A pixel well inside the part: the one farthest from its edge.
    const inside = squaredDistance(full, (i) => labels[i] !== l);
    let at = b.i;
    for (let i = 0; i < labels.length; i++) if (labels[i] === l && inside[i]! > inside[at]!) at = i;
    out.push({ at: { col: (at % W) + 0.5, row: Math.floor(at / W) + 0.5 }, areaM2: sizes[l]! * s * s, gapM });
  }
  return out.sort((a, b) => a.gapM - b.gapM).slice(0, OTHER_ROOFS.max);
}

/** Pixels whose centres lie inside a ring (crop-local metres). */
function rasterize(g: { w: number; h: number }, s: number, ring: readonly XY[], into: Uint8Array): void {
  if (ring.length < 3) return;
  const ys = ring.map((p) => p.y);
  const rTop = Math.max(0, Math.floor(-Math.max(...ys) / s - 0.5));
  const rBottom = Math.min(g.h - 1, Math.ceil(-Math.min(...ys) / s - 0.5));
  for (let r = rTop; r <= rBottom; r++) {
    const y = -(r + 0.5) * s;
    const xs: number[] = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const cFrom = Math.max(0, Math.ceil(xs[k]! / s - 0.5));
      const cTo = Math.min(g.w - 1, Math.floor(xs[k + 1]! / s - 0.5));
      for (let c = cFrom; c <= cTo; c++) into[r * g.w + c] = 1;
    }
  }
}

/**
 * This home's pixels in a mask part it shares with the homes it touches, from Google's box round it (crop-local
 * metres; north-up, so for a home turned on the map it holds corners of its neighbours too). The homes stand in a
 * row along one of the part's two main directions: the one the part runs furthest past the box along. The home's
 * depth across the row is the part's inside the box; its width along the row follows from the box's size, and its
 * middle is the box's: a slab across the row. Faces found on the whole part (`labels`) that lie mostly in the slab are
 * kept whole (their own pixels, up to TERRACE_SNAP_M past the slab) and those mostly out of it dropped, so the cut
 * follows the roofs where the homes' roofs differ; a face running on across the party walls is cut at the slab's
 * sides. All within the box plus JOINED_NEAR_M.
 */
function homeInTerrace(
  g: { w: number; h: number },
  s: number,
  dsm: Float32Array,
  part: Uint8Array,
  box: readonly XY[],
  faces: { labels: Int32Array; planes: readonly Plane[] } | null,
): Uint8Array {
  const n = g.w * g.h;
  const labels = faces?.labels ?? null;
  const boundary = maskBoundary(g, part, s);
  const phi = mainAxis(simplifyClosedIdx(boundary, 0.3).map((k) => boundary[k]!));
  const axes: XY[] = [
    { x: Math.cos(phi), y: Math.sin(phi) },
    { x: -Math.sin(phi), y: Math.cos(phi) },
  ];
  const at = (i: number): XY => ({ x: ((i % g.w) + 0.5) * s, y: -(Math.floor(i / g.w) + 0.5) * s });
  const along = (p: XY, w: XY) => p.x * w.x + p.y * w.y;
  const inBox = nearRing(g, s, box, 0);
  const span = (w: XY, only: Uint8Array | null): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (part[i] !== 1 || (only !== null && only[i] !== 1)) continue;
      const t = along(at(i), w);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return [lo, hi];
  };
  const reach = axes.map((w) => {
    const [lo, hi] = span(w, null);
    const ts = box.map((p) => along(p, w));
    return (hi - lo) / Math.max(s, Math.max(...ts) - Math.min(...ts));
  });
  const w = axes[reach[0]! >= reach[1]! ? 0 : 1]!;
  const across = axes[reach[0]! >= reach[1]! ? 1 : 0]!;
  const [dLo, dHi] = span(across, inBox);
  const depth = Math.max(0, dHi - dLo);
  const bw = Math.max(...box.map((p) => p.x)) - Math.min(...box.map((p) => p.x));
  const bh = Math.max(...box.map((p) => p.y)) - Math.min(...box.map((p) => p.y));
  const c = Math.abs(w.x);
  const sn = Math.abs(w.y);
  // The box of a width x depth rectangle turned to w is (width c + depth sn) by (width sn + depth c): width by least
  // squares from both sides.
  const half = Math.max(s, c * (bw - depth * sn) + sn * (bh - depth * c)) / 2;
  const mid = along({ x: box.reduce((t, p) => t + p.x, 0) / box.length, y: box.reduce((t, p) => t + p.y, 0) / box.length }, w);
  const inSlab = (i: number, slack = 0) => Math.abs(along(at(i), w) - mid) <= half + slack;
  const total = new Map<number, number>();
  const inside = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = labels?.[i] ?? -1;
    if (part[i] !== 1 || k < 0) continue;
    total.set(k, (total.get(k) ?? 0) + 1);
    if (inSlab(i)) inside.set(k, (inside.get(k) ?? 0) + 1);
  }
  const onPlane = (i: number, k: number) => {
    const p = faces!.planes[k]!;
    const q = at(i);
    return Math.abs(dsm[i]! - (p.a * q.x + p.b * q.y + p.c)) <= TERRACE_ON_PLANE_M;
  };
  const near = nearRing(g, s, box, JOINED_NEAR_M);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (part[i] !== 1 || near[i] !== 1) continue;
    const k = labels?.[i] ?? -1;
    const share = k >= 0 ? (inside.get(k) ?? 0) / total.get(k)! : -1;
    if (inSlab(i) ? share < 0 || share > 0.25 : share >= 0.75 && inSlab(i, TERRACE_SNAP_M) && onPlane(i, k)) out[i] = 1;
  }
  return out;
}

/** Pixels whose centres lie inside a ring or within `marginM` of its edges (crop-local metres). */
function nearRing(g: { w: number; h: number }, s: number, ring: readonly XY[], marginM: number): Uint8Array {
  const out = new Uint8Array(g.w * g.h);
  rasterize(g, s, ring, out);
  if (marginM <= 0 || ring.length < 2) return out;
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  const cFrom = Math.max(0, Math.floor((Math.min(...xs) - marginM) / s));
  const cTo = Math.min(g.w - 1, Math.ceil((Math.max(...xs) + marginM) / s));
  const rFrom = Math.max(0, Math.floor(-(Math.max(...ys) + marginM) / s));
  const rTo = Math.min(g.h - 1, Math.ceil(-(Math.min(...ys) - marginM) / s));
  for (let r = rFrom; r <= rTo; r++) {
    for (let c = cFrom; c <= cTo; c++) {
      if (out[r * g.w + c] === 1) continue;
      const p = { x: (c + 0.5) * s, y: -(r + 0.5) * s };
      for (let k = 0; k < ring.length; k++) {
        if (nearestOnSegment(p, ring[k]!, ring[(k + 1) % ring.length]!).d <= marginM) {
          out[r * g.w + c] = 1;
          break;
        }
      }
    }
  }
  return out;
}

/** Thresholds below which a reconstruction needs a person's review (see RoofQuality). */
export const QUALITY_LIMITS = {
  outlineIoU: 0.85,
  edgeFit: 0.75,
  faceCoverage: 0.9,
  meanResidualM: 0.12,
  treeShare: 0.2,
  /** Faces drawn from their pixels (their polygon could not be built) may be at most this share of the roof. */
  fallbackShare: 0.12,
  /** Tree crowns as high as the roof's edge along at most this share of its outline (crownEdgeShare). */
  crownEdgeShare: 0.15,
  /** Raised smooth ground next to the roof in Google's box, at most this share of the roof (hiddenRoofShare). */
  hiddenShare: 0.12,
} as const;

/**
 * How far to trust a reconstruction: the imagery's quality; the outline against Google's mask (overlap, and the share
 * of its length within 0.5 m of the mask's edge); the share of the mask the faces cover; how far the heights sit from
 * their faces' planes on average; the share of the roof under tree crowns; faces whose polygon had to fall back to
 * their pixels. `reasons` lists what fell short; any reason means the roof needs a person's review.
 */
function qualityOf(
  g: { w: number; h: number },
  s: number,
  dsm: Float32Array,
  googleMask: Uint8Array,
  roof: Uint8Array,
  tree: Uint8Array | null,
  labels: Int32Array,
  planes: readonly Plane[],
  outline: readonly XY[],
  topoFaces: readonly { ring: XY[]; fromPixels: boolean }[],
  imagery: string | null,
): RoofQuality {
  const n = g.w * g.h;
  const inOutline = new Uint8Array(n);
  rasterize(g, s, outline, inOutline);
  let both = 0;
  let either = 0;
  let maskPx = 0;
  for (let i = 0; i < n; i++) {
    if (googleMask[i] === 1) maskPx++;
    if (googleMask[i] === 1 && inOutline[i] === 1) both++;
    if (googleMask[i] === 1 || inOutline[i] === 1) either++;
  }
  const outlineIoU = either > 0 ? both / either : 0;
  // The mask's edge, and each outline edge's median distance from it.
  const edgeD = squaredDistance(g, (i) => {
    if (googleMask[i] !== 1) return false;
    const c = i % g.w;
    return c === 0 || c === g.w - 1 || i < g.w || i >= n - g.w || googleMask[i - 1] !== 1 || googleMask[i + 1] !== 1 || googleMask[i - g.w] !== 1 || googleMask[i + g.w] !== 1;
  });
  let fitLen = 0;
  let allLen = 0;
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k]!;
    const b = outline[(k + 1) % outline.length]!;
    const len = dist(a, b);
    if (len < 1e-6) continue;
    const ds: number[] = [];
    for (let t = 0; t <= len; t += s) {
      const x = a.x + ((b.x - a.x) * t) / len;
      const y = a.y + ((b.y - a.y) * t) / len;
      const c = Math.min(g.w - 1, Math.max(0, Math.floor(x / s)));
      const r = Math.min(g.h - 1, Math.max(0, Math.floor(-y / s)));
      ds.push(Math.sqrt(edgeD[r * g.w + c]!) * s);
    }
    ds.sort((p, q) => p - q);
    allLen += len;
    if (ds[Math.floor(ds.length / 2)]! <= 0.5) fitLen += len;
  }
  const edgeFit = allLen > 0 ? fitLen / allLen : 0;
  const inFaces = new Uint8Array(n);
  for (const f of topoFaces) rasterize(g, s, f.ring, inFaces);
  let covered = 0;
  for (let i = 0; i < n; i++) if (googleMask[i] === 1 && inFaces[i] === 1) covered++;
  const faceCoverage = maskPx > 0 ? covered / maskPx : 0;
  // The heights' distance from their face's plane, inside the faces (0.3 m from any face's edge: creases are rounded
  // and eaves meet walls in a height map) and off the tree crowns, capped at half a metre.
  const nearEdge = squaredDistance(g, (i) => {
    const k = labels[i]!;
    if (k < 0) return true;
    const c = i % g.w;
    return (c > 0 && labels[i - 1] !== k) || (c < g.w - 1 && labels[i + 1] !== k) || (i >= g.w && labels[i - g.w] !== k) || (i + g.w < n && labels[i + g.w] !== k);
  });
  const inner2 = (0.3 / s) ** 2;
  let resSum = 0;
  let resN = 0;
  let treePx = 0;
  let roofPx = 0;
  for (let i = 0; i < n; i++) {
    if (roof[i] !== 1) continue;
    roofPx++;
    if (tree?.[i] === 1) {
      treePx++;
      continue;
    }
    const k = labels[i]!;
    const z = dsm[i]!;
    if (k < 0 || !Number.isFinite(z) || nearEdge[i]! <= inner2) continue;
    const p = planes[k]!;
    resSum += Math.min(0.5, Math.abs(z - (p.a * ((i % g.w) + 0.5) * s + p.b * -(Math.floor(i / g.w) + 0.5) * s + p.c)));
    resN++;
  }
  const meanResidualM = resN > 0 ? resSum / resN : 0.5;
  const treeShare = roofPx > 0 ? treePx / roofPx : 0;
  const fallbackFaces = topoFaces.filter((f) => f.fromPixels).length;
  // Faces drawn from their pixels matter when they are a real part of the roof (5% or more of it).
  let fallbackArea = 0;
  let allArea = 0;
  for (const f of topoFaces) {
    const a = Math.abs(signedArea(f.ring));
    allArea += a;
    if (f.fromPixels) fallbackArea += a;
  }
  const reasons: RoofQualityReason[] = [];
  if (imagery !== null && imagery !== 'HIGH') reasons.push('coarse-imagery');
  if (outlineIoU < QUALITY_LIMITS.outlineIoU || edgeFit < QUALITY_LIMITS.edgeFit) reasons.push('outline-off');
  if (faceCoverage < QUALITY_LIMITS.faceCoverage || fallbackArea > QUALITY_LIMITS.fallbackShare * allArea) reasons.push('faces-patchy');
  if (meanResidualM > QUALITY_LIMITS.meanResidualM) reasons.push('rough-heights');
  if (treeShare > QUALITY_LIMITS.treeShare) reasons.push('trees');
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    imagery,
    outlineIoU: round(outlineIoU),
    edgeFit: round(edgeFit),
    faceCoverage: round(faceCoverage),
    meanResidualM: round(meanResidualM),
    treeShare: round(treeShare),
    fallbackFaces,
    reasons,
  };
}

/** A point well inside face k: its polygon's centroid when inside it, else the face pixel farthest from the face's edge. */
function labelPoint(g: { w: number; h: number }, s: number, labels: Int32Array, k: number, ring: readonly XY[]): XY {
  if (ring.length >= 3) {
    let a = 0;
    let cx = 0;
    let cy = 0;
    const o = ring[0]!;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const cr = (p.x - o.x) * (q.y - o.y) - (q.x - o.x) * (p.y - o.y);
      a += cr;
      cx += (p.x - o.x + q.x - o.x) * cr;
      cy += (p.y - o.y + q.y - o.y) * cr;
    }
    if (Math.abs(a) > 1e-9) {
      const c = { x: o.x + cx / (3 * a), y: o.y + cy / (3 * a) };
      let edge = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        const dx = q.x - p.x;
        const dy = q.y - p.y;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.y - p.y) * dy) / len2)) : 0;
        edge = Math.min(edge, dist(c, { x: p.x + t * dx, y: p.y + t * dy }));
      }
      if (pointInRing(c, ring) && edge > 0.6) return c;
    }
  }
  const d = squaredDistance(g, (i) => labels[i] !== k, true);
  let best = -1;
  let at = 0;
  for (let i = 0; i < d.length; i++) {
    if (labels[i] === k && d[i]! > best) {
      best = d[i]!;
      at = i;
    }
  }
  return { x: ((at % g.w) + 0.5) * s, y: -(Math.floor(at / g.w) + 0.5) * s };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * The reconstruction in [lng, lat] as it is stored and drawn: `toLngLat` maps raster-local metres (x east from the
 * left edge, y north from the top edge) to [lng, lat]. Areas in square feet, lengths in feet; faces largest first.
 */
export function toRoof3d(
  local: LocalRoof,
  toLngLat: (x: number, y: number) => LngLat,
  meta: { imageryQuality: string | null; imageryDate: string | null },
): Roof3d {
  const ll = (p: XY): LngLat => {
    const [lng, lat] = toLngLat(p.x, p.y);
    return [round(lng, 8), round(lat, 8)];
  };
  return {
    version: 1,
    outline: local.outline.map(ll),
    faces: local.faces.map((f) => ({
      ring: f.ring.map(ll),
      pitchX12: round(f.pitchX12, 2),
      azimuthDeg: round(f.azimuthDeg, 1),
      planAreaSqFt: round(f.planAreaM2 * SQ_FT_PER_SQ_M, 1),
      slopedAreaSqFt: round(f.slopedAreaM2 * SQ_FT_PER_SQ_M, 1),
      flat: f.flat,
      labelAt: ll(f.label),
    })),
    lines: local.lines.map((l) => ({
      kind: l.kind,
      coords: [ll(l.a), ll(l.b)],
      lengthFt: round(l.lengthM * FT_PER_M, 1),
      riseFt: round(l.riseM * FT_PER_M, 2),
      faces: l.faces,
    })),
    pixelSizeM: local.pixelSizeM,
    imageryQuality: meta.imageryQuality,
    imageryDate: meta.imageryDate,
    quality: { ...local.quality, imagery: meta.imageryQuality, reasons: local.quality.reasons },
  };
}
