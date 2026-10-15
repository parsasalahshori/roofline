import { createHash } from 'node:crypto';
import type { LngLat, Roof3d } from '@roofline/shared';
import { lngLatToUtm, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { type Acceptance, checkRoof, TARGETS } from '../../estimator/roof-3d-compare.ts';
import type { LoadedHouse } from './data.ts';
import { type MultiPoly, iou, rasterize, rectilinearity, ringArea, ringToXY, zoneOfLngLat } from './geometry.ts';
import { maskPartAt } from './canopy.ts';
import { type LidarMetrics, lidarMetrics } from './lidar.ts';
import { DEFAULT_TRUTH, type TruthMetrics, type TruthParams, eagleViewMetrics, isBad, outlineXY, visualMetrics } from './truth.ts';

/*
 * Everything the benchmark measures about one reconstruction, in one plain object (HouseMetrics). The metrics with
 * a truth (an EagleView report or a hand-drawn outline) are in `truth`; the ones every house has are the rest, and
 * `proxy` holds the cross-checks against independent sources (Google's mask, box and area, an OpenStreetMap outline)
 * that are labelled proxy because none of them is the roof's true outline.
 */

export type MetricParams = {
  /** A face this thin (2 x area / perimeter, metres) is a sliver along an edge, not a roof plane (3 ft). */
  thinM: number;
  /** An outline edge within this many degrees of an axis of the best-fitting rectangular frame is rectilinear. */
  rectToleranceDeg: number;
  truth: TruthParams;
};
export const DEFAULT_METRICS: MetricParams = { thinM: 0.9, rectToleranceDeg: 5, truth: DEFAULT_TRUTH };

export type Proxy = {
  /** Our outline against the Google roof mask part under the house (pixels, intersection over union). */
  maskIoU: number | null;
  /** Our outline's lng/lat bounding box against Google's box for the building. */
  boxIoU: number | null;
  /** Plan area of our faces against Google's whole-roof ground area, percent. */
  googleAreaPct: number | null;
  /** Our face count over Google's segment count (segments of 2 m^2 of ground or more). */
  segmentFaceRatio: number | null;
  /** Our outline against an OpenStreetMap building outline, when the house has one. */
  osmIoU: number | null;
};

export type HouseMetrics = {
  status: 'ok' | 'no-roof' | 'failed';
  /** The estimator would not show this roof at all (unusable): it is then measured from its outline as before. */
  unusable: boolean;
  faces: number;
  /** Faces under 25 sq ft of plan area (the checker's junk). */
  slivers: number;
  /** Faces of 25 sq ft or more that are thinner than thinM: slivers along an edge. Informational. */
  thinFaces: number;
  /** Faces steeper than 18/12 without a Google segment that steep (the checker's steep faces). */
  steepJunk: number;
  /** Faces steeper than 18/12 whether or not Google has a steep segment (informational). */
  steepAny: number;
  vertices: number;
  rectilinearity: number;
  planSqFt: number;
  slopedSqFt: number;
  structures: number;
  /** Review reasons the estimator raised (empty: the roof is shown as sure). */
  reasons: string[];
  flagged: boolean;
  /** The checker's targets (main faces against Google's segments, no junk, no steep, outline over the mask). */
  checkerPassed: boolean;
  mainOk: number;
  mainChecked: number;
  /**
   * The outline checked against something it was not traced from (the checker's outline target compares it with the
   * mask it was traced from, after the reconstruction's own cuts, so it always passes): EagleView's outline after the
   * frame alignment when the house has a comparable key, else Google's raw mask part as downloaded (before the ground
   * and terrace cuts; a proxy, labelled so). ok: IoU at least OUTLINE_CHECK_IOU.
   */
  outlineCheck: { source: 'eagleview-aligned' | 'google-mask-raw' | null; iou: number | null; ok: boolean | null };
  /** checkerPassed with the circular outline target replaced by outlineCheck (null when the outline could not be checked). */
  checkerIndependentPassed: boolean | null;
  /** The reconstruction's own outline quality numbers (what the estimator tells the user). */
  selfIoU: number | null;
  selfEdgeFit: number | null;
  selfTreeShare: number | null;
  proxy: Proxy;
  truth: TruthMetrics | null;
  /** Against the house's lidar truth (lidar.ts) when it has accepted lidar truth; null otherwise. */
  lidar?: LidarMetrics | null;
  /** Why the lidar scoring failed (it never fails the run): null when it did not. */
  lidarError?: string | null;
  /** With truth: a flagged roof is right to be when this is true (area off over 10 percent or main pitch over 1/12). */
  bad: boolean | null;
  /** sha1 of the whole reconstruction, to see which houses an edit changed. */
  hash: string;
};

/**
 * An outline that overlaps its independent check by less than this is off: the line the failure analysis drew between
 * good and bad houses on the aligned EagleView set (aligned IoU under 0.85 was one of its two "bad" tests).
 */
export const OUTLINE_CHECK_IOU = 0.85;

export const EMPTY_PROXY: Proxy = { maskIoU: null, boxIoU: null, googleAreaPct: null, segmentFaceRatio: null, osmIoU: null };

export function emptyMetrics(status: 'no-roof' | 'failed', hash = ''): HouseMetrics {
  return {
    status,
    unusable: false,
    faces: 0,
    slivers: 0,
    thinFaces: 0,
    steepJunk: 0,
    steepAny: 0,
    vertices: 0,
    rectilinearity: 0,
    planSqFt: 0,
    slopedSqFt: 0,
    structures: 0,
    reasons: [],
    flagged: false,
    checkerPassed: false,
    mainOk: 0,
    mainChecked: 0,
    outlineCheck: { source: null, iou: null, ok: null },
    checkerIndependentPassed: null,
    selfIoU: null,
    selfEdgeFit: null,
    selfTreeShare: null,
    proxy: EMPTY_PROXY,
    truth: null,
    lidar: null,
    lidarError: null,
    bad: null,
    hash,
  };
}

export function hashOf(json: string): string {
  return createHash('sha1').update(json).digest('hex');
}

function boxIoU(a: { sw: LngLat; ne: LngLat }, b: { sw: LngLat; ne: LngLat }): number | null {
  const w = Math.min(a.ne[0], b.ne[0]) - Math.max(a.sw[0], b.sw[0]);
  const h = Math.min(a.ne[1], b.ne[1]) - Math.max(a.sw[1], b.sw[1]);
  const inter = w > 0 && h > 0 ? w * h : 0;
  const union = (a.ne[0] - a.sw[0]) * (a.ne[1] - a.sw[1]) + (b.ne[0] - b.sw[0]) * (b.ne[1] - b.sw[1]) - inter;
  return union > 0 ? inter / union : null;
}

function proxyOf(h: LoadedHouse, roof: Roof3d, plan: number): Proxy {
  const { layers } = h;
  let maskIoU: number | null = null;
  const zone = utmZoneOfEpsg(layers.epsg);
  if (zone !== null) {
    const { width: w, height: ht, pixelSizeM: s, mask } = layers.raster;
    const part = maskPartAt(layers, h.entry.point);
    if (part.length > 0) {
      const ring = roof.outline.map((p): [number, number] => {
        const u = lngLatToUtm(zone, p[0], p[1]);
        return [(u.easting - layers.originX) / s, (layers.originY - u.northing) / s];
      });
      const ours = rasterize(ring, w, ht);
      const inPart = new Uint8Array(w * ht);
      for (const i of part) inPart[i] = 1;
      let inter = 0;
      let union = 0;
      for (let i = 0; i < ours.length; i++) {
        const a = ours[i] === 1;
        const b = inPart[i] === 1 && mask[i] !== 0;
        if (a && b) inter++;
        if (a || b) union++;
      }
      maskIoU = union > 0 ? inter / union : null;
    }
  }
  const lngs = roof.outline.map((p) => p[0]);
  const lats = roof.outline.map((p) => p[1]);
  const ourBox = { sw: [Math.min(...lngs), Math.min(...lats)] as LngLat, ne: [Math.max(...lngs), Math.max(...lats)] as LngLat };
  const googlePlanSqFt = h.google.groundM2 === null ? null : h.google.groundM2 * 10.7639104167;
  let osmIoU: number | null = null;
  if (h.osm !== null && h.osm.length >= 3) {
    const z = zoneOfLngLat(roof.outline[0]![0], roof.outline[0]![1]);
    const theirs: MultiPoly = [[ringToXY(z, h.osm)]];
    osmIoU = iou(outlineXY(roof).poly, theirs);
  }
  return {
    maskIoU,
    boxIoU: h.google.box === null ? null : boxIoU(ourBox, h.google.box),
    googleAreaPct: googlePlanSqFt !== null && googlePlanSqFt > 0 ? (100 * (plan - googlePlanSqFt)) / googlePlanSqFt : null,
    segmentFaceRatio: h.google.segments > 0 ? roof.faces.length / h.google.segments : null,
    osmIoU,
  };
}

/** The metrics of one reconstruction of one house. `unusable`: the estimator's own verdict (roof-3d.ts unusable()). */
export function houseMetrics(h: LoadedHouse, roof: Roof3d, check: Acceptance, json: string, unusable: boolean, p: MetricParams = DEFAULT_METRICS): HouseMetrics {
  const zone = zoneOfLngLat(roof.outline[0]![0], roof.outline[0]![1]);
  const outline = ringToXY(zone, roof.outline);
  const thin = roof.faces.filter((f) => {
    if (f.planAreaSqFt < TARGETS.junkSqFt) return false;
    const ring = ringToXY(zone, f.ring);
    let perimeter = 0;
    for (let i = 0; i + 1 < ring.length; i++) perimeter += Math.hypot(ring[i + 1]![0] - ring[i]![0], ring[i + 1]![1] - ring[i]![1]);
    return perimeter > 0 && (2 * Math.abs(ringArea(ring))) / perimeter < p.thinM;
  }).length;
  const plan = roof.faces.reduce((t, f) => t + f.planAreaSqFt, 0);
  const sloped = roof.faces.reduce((t, f) => t + f.slopedAreaSqFt, 0);
  const reasons = roof.quality?.reasons ?? [];
  const proxy = proxyOf(h, roof, plan);
  let truth: TruthMetrics | null = null;
  if (h.entry.truth === 'eagleview' && h.eagleview !== null) truth = eagleViewMetrics(roof, h.eagleview, p.truth);
  else if (h.entry.truth === 'visual' && h.visual !== null) truth = visualMetrics(roof, h.visual, p.truth);
  let lidar: LidarMetrics | null = null;
  let lidarError: string | null = null;
  if (h.lidar !== undefined && h.lidar !== null) {
    try {
      lidar = lidarMetrics(roof, h.lidar, h.layers);
    } catch {
      lidarError = 'scoring-failed';
    }
  }
  return {
    status: 'ok',
    unusable,
    faces: roof.faces.length,
    slivers: check.junkFaces,
    thinFaces: thin,
    steepJunk: check.steepFaces,
    steepAny: roof.faces.filter((f) => f.pitchX12 > TARGETS.steepX12).length,
    vertices: roof.outline.length,
    rectilinearity: rectilinearity(outline.slice(0, -1), p.rectToleranceDeg).share,
    planSqFt: Math.round(plan * 10) / 10,
    slopedSqFt: Math.round(sloped * 10) / 10,
    structures: roof.structures?.length ?? 0,
    reasons: [...reasons],
    flagged: reasons.length > 0,
    checkerPassed: check.passed,
    mainOk: check.mainOk,
    mainChecked: check.mainChecked,
    ...independentChecks(check, truth, proxy),
    selfIoU: roof.quality?.outlineIoU ?? null,
    selfEdgeFit: roof.quality?.edgeFit ?? null,
    selfTreeShare: roof.quality?.treeShare ?? null,
    proxy,
    truth,
    lidar,
    lidarError,
    bad: truth !== null && truth.comparable ? isBad(truth) : null,
    hash: hashOf(json),
  };
}

/** The outline check against an independent source and the checker verdict with it (see HouseMetrics.outlineCheck). */
function independentChecks(check: Acceptance, truth: TruthMetrics | null, proxy: Proxy): Pick<HouseMetrics, 'outlineCheck' | 'checkerIndependentPassed'> {
  const aligned = truth !== null && truth.comparable && truth.grade === 'eagleview' ? (truth.aligned ?? null) : null;
  const outlineCheck: HouseMetrics['outlineCheck'] =
    aligned !== null
      ? { source: 'eagleview-aligned', iou: aligned.iou, ok: aligned.iou >= OUTLINE_CHECK_IOU }
      : proxy.maskIoU !== null
        ? { source: 'google-mask-raw', iou: proxy.maskIoU, ok: proxy.maskIoU >= OUTLINE_CHECK_IOU }
        : { source: null, iou: null, ok: null };
  const rest = check.mainOk === check.mainChecked && check.junkFaces === 0 && check.steepFaces === 0;
  return { outlineCheck, checkerIndependentPassed: outlineCheck.ok === null ? null : rest && outlineCheck.ok };
}

export { checkRoof };
