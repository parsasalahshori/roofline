import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { LngLat, Roof3d } from '@roofline/shared';
import { densify, lngLatToUtm, utmToLngLat, utmZoneOfEpsg } from '@roofline/shared/roof-reconstruct';
import { eaveSupport } from '@roofline/shared/roof-reconstruct/eave-support';
import type { RoofLayers } from '../../providers/solar-layers.ts';
import { type MultiPoly, type Pt, area, bestTranslation, boundaryDistance, distancesToBoundary, iou, ringToXY, roundHalfEven, translate } from './geometry.ts';
import { outlineXY } from './truth.ts';

/*
 * Lidar roof truth (truth grade 'lidar'): an outline, plane pitches and areas built from USGS 3DEP lidar by the
 * tools in tools/roof-bench/lidar (Python; docs/roof-3d/truth.md), independently of the product's reconstruction,
 * shifted onto Google's frame by a rigid registration of the lidar roofs to Google's height map, and accepted per house
 * by validate.py (<bench>/lidar/index.json). Leaf-off lidar sees roofs between bare branches, which Google's
 * photogrammetry cannot: these are the houses whose canopy-hidden edges can be scored at all.
 *
 * Besides the outline metrics (IoU, boundary distance, area) the hidden-edge metrics score only the stretches the
 * height map cannot vouch for: our outline's samples whose eave support (eave-support.ts, the product's evidence) is
 * 'none', measured to the lidar outline; and, a definition that does not move with the reconstruction, the lidar
 * outline's samples whose eave support on Google's heights is 'none', measured to our outline.
 */

/** A truth file this big is not a truth file (a house's is a few hundred kilobytes). */
export const MAX_LIDAR_FILE_BYTES = 8 * 1024 * 1024;
/** A hidden-edge sample this close to the other outline is right (the failure taxonomy's line). */
export const HIDDEN_WITHIN_M = 0.5;

const Ring = z.array(z.tuple([z.number(), z.number()])).min(4);

export const LidarTruthSchema = z
  .object({
    slug: z.string(),
    ok: z.literal(true),
    version: z.number(),
    unit: z.string().optional(),
    source: z.object({ project: z.string(), workunit: z.string(), ql: z.string(), pointDates: z.array(z.string().nullable()).nullable(), credit: z.string() }).passthrough(),
    frame: z.object({ dxM: z.number(), dyM: z.number(), dzM: z.number(), madM: z.number() }).passthrough(),
    method: z.object({ expectedEdgeErrorM: z.number(), spacingM: z.number(), cellM: z.number() }).passthrough(),
    outline: z.array(z.object({ outer: Ring, holes: z.array(Ring) })).min(1),
    planAreaM2: z.number().nonnegative(),
    slopedAreaM2: z.number().nonnegative(),
    mainPitchX12: z.number().nullable(),
    planes: z.array(z.object({ pitchX12: z.number(), azimuthDeg: z.number().nullable(), planM2: z.number(), slopedM2: z.number(), rings: z.array(Ring) }).passthrough()),
    checks: z.record(z.string(), z.unknown()),
  })
  .passthrough();
export type LidarTruth = z.infer<typeof LidarTruthSchema>;

export const LIDAR_GRADES = ['lidar', 'rejected', 'none'] as const;
export const LidarIndexSchema = z
  .object({
    version: z.literal(1),
    credit: z.string(),
    rules: z.record(z.string(), z.unknown()),
    houses: z.record(
      z.string(),
      z.object({ grade: z.enum(LIDAR_GRADES), reasons: z.array(z.string()), leafOff: z.boolean().nullable().optional(), project: z.string().optional() }).passthrough(),
    ),
  })
  .passthrough();
export type LidarIndex = z.infer<typeof LidarIndexSchema>;

/** What the manifest entry carries about lidar (merged in from the index; never written to manifest.json). */
export type LidarGrade = { grade: (typeof LIDAR_GRADES)[number]; leafOff: boolean | null };

export function lidarDir(bench: string): string {
  return path.join(bench, 'lidar');
}

/** The lidar index, or null when the bench has none (then no house has lidar truth). Throws on a malformed index. */
export function readLidarIndex(bench: string): LidarIndex | null {
  const file = path.join(lidarDir(bench), 'index.json');
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_LIDAR_FILE_BYTES) throw new Error('lidar/index.json is too large');
  return LidarIndexSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** A short fingerprint of which houses have accepted lidar truth and what it is: a baseline records it. */
export function lidarIndexHash(index: LidarIndex | null, truths: ReadonlyMap<string, string> = new Map()): string | null {
  if (index === null) return null;
  const core = Object.keys(index.houses)
    .sort()
    .map((s) => [s, index.houses[s]!.grade, truths.get(s) ?? null]);
  return createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12);
}

/** The accepted lidar truth of a house; null when it has none. Throws when the file is unreadable or malformed. */
export function readLidarTruth(bench: string, slug: string): { truth: LidarTruth; sha1: string } | null {
  const file = path.join(lidarDir(bench), slug, 'truth.json');
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_LIDAR_FILE_BYTES) throw new Error(`${slug}: lidar truth is too large`);
  const text = readFileSync(file, 'utf8');
  return { truth: LidarTruthSchema.parse(JSON.parse(text)), sha1: createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

/** Distances of one set of samples to the other outline: pooled so cohorts can add them up. */
export type EdgeSet = { samples: number; sumM: number; within: number };
const EMPTY_EDGES: EdgeSet = { samples: 0, sumM: 0, within: 0 };

export type LidarMetrics = {
  grade: 'lidar';
  /** Our outline and the lidar outline are the same building: IoU >= 0.5. Only comparable houses are aggregated. */
  comparable: boolean;
  /** In Google's frame (the lidar was registered to it once, independently of any reconstruction). */
  iou: number;
  meanBoundaryM: number;
  hd95M: number;
  /** After the best translation within 3 m (the same rule as EagleView's aligned metric), for comparison. */
  aligned: { iou: number; meanBoundaryM: number; hd95M: number; shiftM: [number, number] };
  /** (ours - lidar) / lidar, percent: plan area of our outline, sloped area of our faces. */
  planErrPct: number | null;
  slopedErrPct: number | null;
  mainPitchOurs: number | null;
  mainPitchTruth: number | null;
  mainPitchErr: number | null;
  /** Our outline's samples the height map cannot vouch for (eave support 'none'), to the lidar outline. */
  hidden: EdgeSet;
  /** Our outline's samples with eave support (strong or weak), to the lidar outline. */
  visible: EdgeSet;
  /** The lidar outline's samples whose eave support on Google's heights is 'none', to our outline (does not move with the reconstruction). */
  truthHidden: EdgeSet;
  /** Set when the eave support could not be measured (the hidden-edge sets are then empty). */
  edgeError: string | null;
};

/** The eave-support scorer of the hidden-edge sets: 'midpoint' (eaveSupport as the product calls it) or 'dense'. */
export const SUPPORT_SCORER: 'midpoint' | 'dense' = process.env.ROOF3D_BENCH_SUPPORT === 'dense' ? 'dense' : 'midpoint';
/** The dense scorer's piece length, metres: eaveSupport's own sample step. */
const SUPPORT_STEP_M = 0.2;

/** supportScorer: how the hidden-edge sets read eave support (SUPPORT_SCORER; supportAlong). */
export type LidarParams = { boundaryStepM: number; withinM: number; supportScorer: 'midpoint' | 'dense' };
export const DEFAULT_LIDAR: LidarParams = { boundaryStepM: 0.2, withinM: HIDDEN_WITHIN_M, supportScorer: SUPPORT_SCORER };

/** The lidar outline in metres (the bench's zone for the house). */
export function lidarXY(zone: ReturnType<typeof outlineXY>['zone'], t: LidarTruth): MultiPoly {
  return t.outline.map((p) => [ringToXY(zone, p.outer), ...p.holes.map((h) => ringToXY(zone, h))]);
}

/**
 * Eave support of every sample along a lng/lat ring, on Google's height map, as points in the bench's metres.
 * Null with a reason when it cannot be measured (no UTM zone, a ring off the raster, eaveSupport's own refusal).
 */
export function supportAlong(
  ring: readonly LngLat[],
  layers: RoofLayers,
  zone: ReturnType<typeof outlineXY>['zone'],
  scorer: 'midpoint' | 'dense' = SUPPORT_SCORER,
): { samples: { p: Pt; none: boolean }[] } | { error: string } {
  const lz = utmZoneOfEpsg(layers.epsg);
  if (lz === null) return { error: 'no-zone' };
  const local = ring.map(([lng, lat]) => {
    const u = lngLatToUtm(lz, lng, lat);
    return { x: u.easting - layers.originX, y: u.northing - layers.originY };
  });
  const r = layers.raster;
  // eaveSupport (since c606b7a4) clamps each sample to its edge's midpoint (`Math.min(t, L / 2)`), so the second half of
  // every edge is never measured and the midpoint is counted once per missing sample. The dense scorer measures the ring
  // in 0.2 m pieces (one sample each) so every stretch counts once. Opt-in (ROOF3D_BENCH_SUPPORT=dense) so baselines
  // made before it stay comparable; a baseline records which one it used.
  const pts = scorer === 'dense' ? densify(local, SUPPORT_STEP_M).pts : local;
  const s = eaveSupport(pts, { width: r.width, height: r.height, pixelSizeM: r.pixelSizeM, dsm: r.dsm }, null, scorer === 'dense' ? { stepM: SUPPORT_STEP_M } : undefined);
  if (!s.ok) return { error: s.reason };
  return {
    samples: s.samples.map((q) => {
      const [lng, lat] = utmToLngLat(lz, q.x + layers.originX, q.y + layers.originY);
      const u = lngLatToUtm(zone, lng, lat);
      return { p: [u.easting, u.northing] as Pt, none: q.support === 'none' };
    }),
  };
}

function edgeSet(points: readonly Pt[], to: MultiPoly, withinM: number): EdgeSet {
  if (points.length === 0) return EMPTY_EDGES;
  const d = distancesToBoundary(points, to);
  return { samples: d.length, sumM: d.reduce((t, x) => t + x, 0), within: d.filter((x) => x <= withinM).length };
}

function dominantPitch(items: readonly { pitch: number; area: number }[]): number | null {
  const acc = new Map<number, number>();
  for (const { pitch, area: a } of items) acc.set(roundHalfEven(pitch), (acc.get(roundHalfEven(pitch)) ?? 0) + a);
  let best: number | null = null;
  let bestArea = -Infinity;
  for (const [k, a] of acc) {
    if (a > bestArea) {
      best = k;
      bestArea = a;
    }
  }
  return best;
}

/** One reconstruction scored against a house's lidar truth. Pure and deterministic; throws only on a broken roof. */
export function lidarMetrics(roof: Roof3d, t: LidarTruth, layers: RoofLayers, p: LidarParams = DEFAULT_LIDAR): LidarMetrics {
  const { zone, poly: ours } = outlineXY(roof);
  const theirs = lidarXY(zone, t);
  const overlap = iou(ours, theirs) ?? 0;
  const bd = boundaryDistance(ours, theirs, p.boundaryStepM);
  const shift = bestTranslation(ours, theirs, 3);
  const abd = boundaryDistance(ours, translate(theirs, shift.dx, shift.dy), p.boundaryStepM);
  const plan = area(ours);
  const sloped = roof.faces.reduce((s, f) => s + f.slopedAreaSqFt, 0) / 10.7639104167;
  const oursMain = dominantPitch(roof.faces.filter((f) => !f.flat).map((f) => ({ pitch: f.pitchX12, area: f.slopedAreaSqFt })));
  let hidden = EMPTY_EDGES;
  let visible = EMPTY_EDGES;
  let edgeError: string | null = null;
  const mine = supportAlong(roof.outline, layers, zone, p.supportScorer);
  if ('error' in mine) edgeError = `ours: ${mine.error}`;
  else {
    hidden = edgeSet(mine.samples.filter((q) => q.none).map((q) => q.p), theirs, p.withinM);
    visible = edgeSet(mine.samples.filter((q) => !q.none).map((q) => q.p), theirs, p.withinM);
  }
  const truthPts: Pt[] = [];
  for (const part of t.outline) {
    const s = supportAlong(part.outer as LngLat[], layers, zone, p.supportScorer);
    if ('error' in s) {
      edgeError ??= `truth: ${s.error}`;
      continue;
    }
    for (const q of s.samples) if (q.none) truthPts.push(q.p);
  }
  const truthHidden = edgeSet(truthPts, ours, p.withinM);
  return {
    grade: 'lidar',
    comparable: overlap >= 0.5,
    iou: overlap,
    meanBoundaryM: bd.mean,
    hd95M: bd.hd95,
    aligned: { iou: shift.iou, meanBoundaryM: abd.mean, hd95M: abd.hd95, shiftM: [shift.dx, shift.dy] },
    planErrPct: t.planAreaM2 > 0 ? (100 * (plan - t.planAreaM2)) / t.planAreaM2 : null,
    slopedErrPct: t.slopedAreaM2 > 0 ? (100 * (sloped - t.slopedAreaM2)) / t.slopedAreaM2 : null,
    mainPitchOurs: oursMain,
    mainPitchTruth: t.mainPitchX12,
    mainPitchErr: oursMain === null || t.mainPitchX12 === null ? null : Math.abs(oursMain - t.mainPitchX12),
    hidden,
    visible,
    truthHidden,
    edgeError,
  };
}

/** Pooled edge sets: their sum. */
export function addEdges(a: EdgeSet, b: EdgeSet): EdgeSet {
  return { samples: a.samples + b.samples, sumM: a.sumM + b.sumM, within: a.within + b.within };
}
