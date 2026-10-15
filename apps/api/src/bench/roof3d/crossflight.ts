import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type LidarTruth, LidarTruthSchema, MAX_LIDAR_FILE_BYTES, lidarDir } from './lidar.ts';
import { LidarEdgeInfoSchema } from './lidar-edges.ts';

/*
 * Cross-flight lidar truth (scripts/roof-bench-lidar/crossflight.py; docs/roof-3d/truth-crossflight.md).
 *
 * A method that READS a lidar flight (the fusion step) must never be scored on lidar truth built from that same flight:
 * the truth would share its returns, its gaps and its misclassified branches. Where a house is covered by two 3DEP
 * flights, crossflight.py registers per flight F the truth T built from a DIFFERENT flight (another project, checked
 * for a roof change between the two), in lidar/<slug>/crossflight.json. This module picks that truth for the flight a
 * run fused, and refuses (never falls back to the primary truth) when there is none: a house without cross-flight
 * truth simply has no lidar score in that run.
 */

const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

const Accepted = z
  .object({
    truthUnit: z.string(),
    truthProject: z.string(),
    tier: z.enum(['fine', 'coarse']),
    expectedEdgeErrorM: z.number(),
    interFlightIoU: z.number(),
  })
  .passthrough();
const Refused = z.object({ truthUnit: z.null(), refused: z.array(z.string()) }).passthrough();

export const CrossFlightSchema = z
  .object({
    version: z.literal(1),
    slug: z.string(),
    units: z.array(z.object({ unit: z.string(), project: z.string().nullable() }).passthrough()),
    registry: z.record(z.string(), z.union([Accepted, Refused])),
  })
  .passthrough();
export type CrossFlight = z.infer<typeof CrossFlightSchema>;

/** 'fine': the truth passes every acceptance rule. 'coarse': it fails only A2 (QL2 density): area and IoU, not hidden edges. */
export type CrossFlightTier = 'fine' | 'coarse';

export type CrossFlightPick =
  | { truth: LidarTruth; sha1: string; tier: CrossFlightTier; fusedUnit: string; truthUnit: string }
  | { truth: null; reason: string; fusedUnit: string | null };

/** The flight a run fused for a house: the workunit of its crop in <bench>/<edgesDir>/<slug>.json; null when it has no crop. */
export function fusedFlightOf(bench: string, edgesDir: string, slug: string): string | null {
  const file = path.join(bench, edgesDir, `${slug}.json`);
  if (!existsSync(file)) return null;
  return LidarEdgeInfoSchema.parse(JSON.parse(readFileSync(file, 'utf8'))).workunit;
}

export function readCrossFlight(bench: string, slug: string): CrossFlight | null {
  const file = path.join(lidarDir(bench), slug, 'crossflight.json');
  if (!existsSync(file)) return null;
  if (statSync(file).size > MAX_REGISTRY_BYTES) throw new Error(`${slug}: crossflight.json is too large`);
  return CrossFlightSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * The lidar truth to score a house against when the run fused `fusedUnit`: built from another flight, or null with a
 * machine-readable reason. Throws when the files are malformed, and when the registry would hand back the fused
 * flight's own truth (or one of the same project): that is a corrupt registry, never something to score.
 */
export function selectCrossFlightTruth(bench: string, slug: string, fusedUnit: string | null, opts: { allowCoarse: boolean }): CrossFlightPick {
  if (fusedUnit === null) return { truth: null, reason: 'no-fused-flight', fusedUnit };
  const reg = readCrossFlight(bench, slug);
  if (reg === null) return { truth: null, reason: 'no-crossflight-record', fusedUnit };
  const e = reg.registry[fusedUnit];
  if (e === undefined) return { truth: null, reason: 'fused-flight-not-registered', fusedUnit };
  if (e.truthUnit === null) return { truth: null, reason: `refused:${(e as z.infer<typeof Refused>).refused.join('+')}`, fusedUnit };
  const a = e as z.infer<typeof Accepted>;
  if (a.tier === 'coarse' && !opts.allowCoarse) return { truth: null, reason: 'coarse-truth', fusedUnit };
  const fusedProject = reg.units.find((u) => u.unit === fusedUnit)?.project ?? null;
  const file = path.join(lidarDir(bench), slug, 'units', a.truthUnit, 'truth.json');
  if (!existsSync(file)) throw new Error(`${slug}: cross-flight truth ${a.truthUnit} is registered but missing`);
  if (statSync(file).size > MAX_LIDAR_FILE_BYTES) throw new Error(`${slug}: cross-flight truth is too large`);
  const text = readFileSync(file, 'utf8');
  const truth = LidarTruthSchema.parse(JSON.parse(text));
  // The guard: the truth must come from another flight than the one the method read.
  if (a.truthUnit === fusedUnit || truth.source.workunit === fusedUnit || (fusedProject !== null && truth.source.project === fusedProject)) {
    throw new Error(`${slug}: cross-flight registry hands back the fused flight's own truth (${fusedUnit}): circular, refusing`);
  }
  return { truth, sha1: createHash('sha1').update(text).digest('hex').slice(0, 12), tier: a.tier, fusedUnit, truthUnit: a.truthUnit };
}

/** A fingerprint of the cross-flight truth set a run scored against (differs from any primary-truth fingerprint). */
export function crossFlightHash(picks: ReadonlyMap<string, CrossFlightPick>, allowCoarse: boolean): string {
  const core = [...picks.keys()].sort().map((s) => {
    const p = picks.get(s)!;
    return p.truth === null ? [s, p.fusedUnit, p.reason] : [s, p.fusedUnit, p.truthUnit, p.sha1];
  });
  return `xf${allowCoarse ? '+coarse' : ''}:${createHash('sha1').update(JSON.stringify(core)).digest('hex').slice(0, 12)}`;
}
