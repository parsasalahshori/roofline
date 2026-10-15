import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Roof3d } from '@roofline/shared';
import { type MultiPoly, area, boundaryDistance, iou, ringToXY } from './geometry.ts';
import { alignedOutline, outlineXY } from './truth.ts';

/*
 * County truth (grade 'county'): a building footprint a county or state GIS office digitized itself (not a machine-
 * learning footprint), picked for the house and accepted by scripts/roof-bench-free/county_truth.py, which never reads
 * the reconstruction or lidar (<bench>/free/county/index.json and <slug>/truth.json; docs/roof-3d/free-sources.md).
 * Footprints sit in their publisher's frame, so, like EagleView, the outline is also scored after the best translation
 * within ALIGN_MAX_SHIFT_M. A footprint is a plan outline only: no faces, pitch or sloped area.
 *
 * Known bias (validation.json): the photogrammetric footprints are about 7% smaller in plan than lidar roof outlines
 * (aligned IoU 0.87 median on 7 houses): they trace walls or a tight roof line, not the drip edge. Against EagleView
 * they are a coarser outline than our own reconstruction. Use this grade for extent (a missing wing, an area 15-20%
 * low), not for boundary precision.
 * A source digitized from lidar is marked lidarDerived: a method that reads lidar must not be scored on it.
 */

/** A truth file this big is not a footprint (a house's is a few kilobytes). */
export const MAX_COUNTY_FILE_BYTES = 1024 * 1024;

const Ring = z.array(z.tuple([z.number(), z.number()])).min(4);

export const CountyTruthSchema = z
  .object({
    slug: z.string(),
    ok: z.literal(true),
    version: z.literal(1),
    grade: z.literal('county'),
    source: z.object({ name: z.string(), method: z.string(), lidarDerived: z.boolean(), credit: z.string(), featureIds: z.array(z.string()), dates: z.array(z.string()) }).passthrough(),
    outline: z.array(z.object({ outer: Ring, holes: z.array(Ring) })).min(1),
    planAreaM2: z.number().positive(),
  })
  .passthrough();
export type CountyTruth = z.infer<typeof CountyTruthSchema>;

export const COUNTY_GRADES = ['county', 'rejected', 'none'] as const;
export const CountyIndexSchema = z
  .object({
    version: z.literal(1),
    credit: z.string(),
    rules: z.record(z.string(), z.unknown()),
    houses: z.record(z.string(), z.object({ grade: z.enum(COUNTY_GRADES), reasons: z.array(z.string()), source: z.string(), lidarDerived: z.boolean() }).passthrough()),
  })
  .passthrough();
export type CountyIndex = z.infer<typeof CountyIndexSchema>;

export function countyDir(bench: string): string {
  return path.join(bench, 'free', 'county');
}

/** The county index, or null when the bench has none. Throws on a malformed or oversized index. */
export function readCountyIndex(bench: string): CountyIndex | null {
  const file = path.join(countyDir(bench), 'index.json');
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_COUNTY_FILE_BYTES) throw new Error('free/county/index.json is too large');
  return CountyIndexSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** A house's accepted county truth and the file's short sha1; null when it has none. Throws when malformed. */
export function readCountyTruth(bench: string, slug: string): { truth: CountyTruth; sha1: string } | null {
  const file = path.join(countyDir(bench), slug, 'truth.json');
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_COUNTY_FILE_BYTES) throw new Error(`${slug}: county truth is too large`);
  const text = readFileSync(file, 'utf8');
  const truth = CountyTruthSchema.parse(JSON.parse(text));
  if (truth.slug !== slug) throw new Error(`${slug}: county truth names ${truth.slug}`);
  return { truth, sha1: createHash('sha1').update(text).digest('hex').slice(0, 12) };
}

/** A short fingerprint of which houses have accepted county truth and what it is: a report records it. */
export function countyIndexHash(index: CountyIndex | null, truths: ReadonlyMap<string, string> = new Map()): string | null {
  if (index === null) return null;
  const core = Object.keys(index.houses)
    .sort()
    .map((s) => [s, index.houses[s]!.grade, truths.get(s) ?? null]);
  return createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12);
}

export type CountyMetrics = {
  grade: 'county';
  /** The same building: IoU >= 0.5 after alignment. Only comparable houses are aggregated. */
  comparable: boolean;
  lidarDerived: boolean;
  /** In the publisher's frame, against Google's (raw). */
  iou: number;
  meanBoundaryM: number;
  /** After the best translation within ALIGN_MAX_SHIFT_M (EagleView's rule). */
  aligned: { iou: number; meanBoundaryM: number; hd95M: number; shiftM: [number, number] };
  /** (ours - county) / county, plan area, percent. */
  planErrPct: number;
};

export function countyXY(zone: ReturnType<typeof outlineXY>['zone'], t: CountyTruth): MultiPoly {
  return t.outline.map((p) => [ringToXY(zone, p.outer), ...p.holes.map((h) => ringToXY(zone, h))]);
}

/** One reconstruction scored against a house's county footprint. Pure and deterministic. */
export function countyMetrics(roof: Roof3d, t: CountyTruth, stepM = 0.2): CountyMetrics {
  const { zone, poly: ours } = outlineXY(roof);
  const theirs = countyXY(zone, t);
  const raw = iou(ours, theirs) ?? 0;
  const bd = boundaryDistance(ours, theirs, stepM);
  const al = alignedOutline(ours, theirs, stepM);
  const keyArea = area(theirs);
  return {
    grade: 'county',
    comparable: al.iou >= 0.5,
    lidarDerived: t.source.lidarDerived,
    iou: raw,
    meanBoundaryM: bd.mean,
    aligned: { iou: al.iou, meanBoundaryM: al.meanBoundaryM, hd95M: al.hd95M, shiftM: al.shiftM },
    planErrPct: keyArea > 0 ? (100 * (area(ours) - keyArea)) / keyArea : 0,
  };
}
