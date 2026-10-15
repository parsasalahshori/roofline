import type { Roof3d } from '@roofline/shared';
import { checkRoof } from '../../estimator/roof-3d-compare.ts';
import { roofOnLayers, type RoofOnLayersOptions, steepRoof, unusable } from '../../estimator/roof-3d.ts';
import { withGoogleCheck } from '../../estimator/roof-3d-compare.ts';
import type { LoadedHouse } from './data.ts';
import { DEFAULT_METRICS, type HouseMetrics, type MetricParams, emptyMetrics, hashOf, houseMetrics } from './metrics.ts';

/** The seeds of the random sampling in the plane search; results are reported as the mean over them with the range. */
export const SEEDS: readonly number[] = [7, 8, 9];

/**
 * The hidden-edge method under test (ReconstructOptions.hiddenEdge), from the environment so a run of the same commit
 * can compare methods: ROOF3D_HIDDEN_EDGE=planes or photo, with ROOF3D_HIDDEN_EDGE_PARAMS a JSON object of parameter overrides
 * (sensitivity runs). Unset: off, as the server runs.
 */
export function hiddenEdgeFromEnv(env: NodeJS.ProcessEnv = process.env): RoofOnLayersOptions['hiddenEdge'] {
  const method = env.ROOF3D_HIDDEN_EDGE;
  if (method === undefined || method === '') return undefined;
  const raw = env.ROOF3D_HIDDEN_EDGE_PARAMS;
  const params = raw !== undefined && raw !== '' ? (JSON.parse(raw) as Record<string, number>) : undefined;
  if (method === 'planes') return { method, ...(params !== undefined ? { planes: params } : {}) };
  if (method === 'photo') return { method, ...(params !== undefined ? { photo: params } : {}) };
  // Combinations: the parameter overrides (if any) go to both steps' records; each step reads only its own keys.
  if (method === 'photo+planes' || method === 'planes+photo') return { method, ...(params !== undefined ? { planes: params, photo: params } : {}) };
  throw new Error(`ROOF3D_HIDDEN_EDGE: unknown method ${JSON.stringify(method)} (planes, photo, photo+planes, planes+photo)`);
}
const HIDDEN_EDGE = hiddenEdgeFromEnv();

export type Once = { metrics: HouseMetrics; json: string; ms: number };

/**
 * One reconstruction of one house, as the server makes it (roofOnLayers, then the Google check), scored. A throw
 * becomes status 'failed' (and a reconstruction with no roof 'no-roof'): the benchmark never stops on a house.
 */
export function reconstructOnce(h: LoadedHouse, seed: number, p: MetricParams = DEFAULT_METRICS): Once {
  const started = performance.now();
  let roof: Roof3d | null;
  try {
    const found = roofOnLayers(h.layers, h.entry.point, {
      steep: steepRoof(h.building),
      building: h.building,
      seed,
      ...(HIDDEN_EDGE !== undefined ? { hiddenEdge: HIDDEN_EDGE } : {}),
      ...(h.lidarPoints != null ? { lidar: h.lidarPoints } : {}),
    });
    roof = found === null ? null : withGoogleCheck(found, h.building);
  } catch {
    return { metrics: emptyMetrics('failed'), json: 'failed', ms: performance.now() - started };
  }
  const ms = performance.now() - started;
  if (roof === null) return { metrics: emptyMetrics('no-roof'), json: 'no-roof', ms };
  const json = JSON.stringify(roof);
  try {
    return { metrics: houseMetrics(h, roof, checkRoof(roof, h.building), json, unusable(roof), p), json, ms };
  } catch {
    // Scoring failed (not the reconstruction): the roof is kept as a failure so it shows up in the counts.
    return { metrics: { ...emptyMetrics('failed', hashOf(json)) }, json, ms };
  }
}

export type HouseRun = {
  slug: string;
  /** Metrics per seed, in SEEDS order. */
  seeds: HouseMetrics[];
  /** Milliseconds of every run (each seed, then the repeat). */
  runtimesMs: number[];
  /** The first seed run twice gave byte-identical reconstructions. */
  deterministic: boolean;
  /** No seed's result differs materially from the first seed's (see materiallyDiffers). */
  seedStable: boolean;
  /** Every seed gave a byte-identical reconstruction (a stricter test than seedStable). */
  seedIdentical: boolean;
};

/**
 * Whether two results of the same house are different enough to matter: another status or face count, another count
 * of slivers or steep faces, another checker or review verdict, the roof area off by over 1 percent, or the outline
 * overlap with the answer key off by over 0.005. Plane-fit noise in the last decimals is not.
 */
export function materiallyDiffers(a: HouseMetrics, b: HouseMetrics): boolean {
  if (a.status !== b.status || a.faces !== b.faces || a.slivers !== b.slivers || a.steepJunk !== b.steepJunk) return true;
  if (a.checkerPassed !== b.checkerPassed || a.flagged !== b.flagged || a.reasons.join() !== b.reasons.join()) return true;
  if (Math.abs(a.slopedSqFt - b.slopedSqFt) > 0.01 * Math.max(a.slopedSqFt, 1)) return true;
  return a.truth !== null && b.truth !== null && Math.abs(a.truth.iou - b.truth.iou) > 0.005;
}

export function runHouse(h: LoadedHouse, seeds: readonly number[] = SEEDS): HouseRun {
  const runs = seeds.map((s) => reconstructOnce(h, s));
  const again = reconstructOnce(h, seeds[0]!);
  return {
    slug: h.entry.slug,
    seeds: runs.map((r) => r.metrics),
    runtimesMs: [...runs.map((r) => r.ms), again.ms],
    deterministic: again.json === runs[0]!.json,
    seedStable: runs.every((r) => !materiallyDiffers(runs[0]!.metrics, r.metrics)),
    seedIdentical: runs.every((r) => r.json === runs[0]!.json),
  };
}

/** Milliseconds a fixed piece of arithmetic takes on this machine now (the fastest of five): runtimes are compared after dividing by it. */
export function calibrationMs(): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    let x = 0;
    for (let i = 1; i < 4_000_000; i++) x += Math.sqrt(i) * Math.sin(i * 1e-3);
    if (x === 12345.678) throw new Error('unreachable');
    best = Math.min(best, performance.now() - t);
  }
  return best;
}
