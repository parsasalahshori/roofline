import type { LngLat, Roof3dLidarNote } from '@roofline/shared';
import type { AppDeps } from '../app.ts';
import type { LidarPointsUtm } from '../estimator/roof-3d.ts';
import type { LidarCropUtm, LidarEvidence } from './usgs-lidar-service.ts';

/*
 * The one place Measure meets the lidar service: what roof-3d's attempt hands the reconstruction (points, only with
 * USGS_LIDAR_MODE=on) and what it records on the snapshot (provenance, or the typed reason there is none). Never
 * rejects and never waits longer than the service's measure budget.
 */

export type LidarMode = 'off' | 'prefetch' | 'on';

export function lidarModeOf(deps: AppDeps): LidarMode {
  const m = (deps.config as { USGS_LIDAR_MODE?: unknown } | undefined)?.USGS_LIDAR_MODE;
  return m === 'prefetch' || m === 'on' ? m : 'off';
}

function lidarOn(deps: AppDeps): boolean {
  return lidarModeOf(deps) !== 'off' && deps.usgsLidar != null && deps.usgsLidar.configured;
}

/** Whole years between the flight's last day and Google's imagery date; null when either is unknown. */
export function ageYears(flown: string | null, imagery: string | null): number | null {
  if (flown === null || imagery === null) return null;
  const a = Date.parse(`${flown}T00:00:00Z`);
  const b = Date.parse(imagery.length === 7 ? `${imagery}-01T00:00:00Z` : `${imagery}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor(Math.abs(b - a) / (365.25 * 86_400_000));
}

function noteOf(e: LidarEvidence, used: boolean, imageryDate: string | null): Roof3dLidarNote {
  if ('none' in e) return { status: 'none', reason: e.none };
  const s = e.crop.source;
  return {
    status: used ? 'used' : 'kept',
    workunit: s.workunit,
    project: s.project,
    ql: s.ql,
    flown: [s.collectStart, s.collectEnd],
    leafOff: s.leafOff,
    ageYears: ageYears(s.collectEnd, imageryDate),
    points: s.points,
    credit: s.credit,
  };
}

function pointsOf(c: LidarCropUtm, imageryDate: string | null): LidarPointsUtm {
  return { epsg: c.epsg, originE: c.originE, originN: c.originN, dx: c.dx, dy: c.dy, z: c.z, flags: c.flags, leafOff: c.source.leafOff, ageYears: ageYears(c.source.collectEnd, imageryDate) };
}

/**
 * Starts reading the lidar for the roof at `point` (null when lidar is off). Started before Google's layers are
 * fetched so its budget runs alongside them rather than after.
 */
export function startLidar(deps: AppDeps, point: LngLat): Promise<LidarEvidence> | null {
  if (!lidarOn(deps)) return null;
  return deps.usgsLidar!.forMeasure(point);
}

/** What the reconstruction gets (points, only with mode on and a crop) and what the snapshot records. */
export async function lidarForRoof(started: Promise<LidarEvidence> | null, deps: AppDeps, imageryDate: string | null): Promise<{ points: LidarPointsUtm | null; note: Roof3dLidarNote } | null> {
  if (started === null) return null;
  const evidence = await started;
  const use = lidarModeOf(deps) === 'on' && 'crop' in evidence;
  return { points: use && 'crop' in evidence ? pointsOf(evidence.crop, imageryDate) : null, note: noteOf(evidence, use, imageryDate) };
}

/**
 * Starts fetching the lidar round a searched address (Measure search prefetch), and queues the area job for the
 * square round it (`companyId` is the job's owner; the work is global). Nothing when lidar is off.
 */
export function prefetchLidar(deps: AppDeps, point: LngLat, companyId?: string): Promise<void> {
  if (!lidarOn(deps)) return Promise.resolve();
  const area = lidarAreaOf(point);
  const queued =
    companyId === undefined
      ? Promise.resolve()
      : deps.jobs.send('lidar-area', { companyId, lidarBox: area.box }, { singletonKey: area.key }).catch((err: unknown) => deps.logError?.(err, 'lidar-area'));
  return Promise.all([deps.usgsLidar!.prefetch(point), queued]).then(() => undefined);
}

/** Area job squares: a 0.01 degree grid (about 1 km, one 3DEP tile), the square holding the point. */
const AREA_DEG = 0.01;
export function lidarAreaOf(point: LngLat): { box: [number, number, number, number]; key: string } {
  const i = Math.floor(point[0] / AREA_DEG);
  const j = Math.floor(point[1] / AREA_DEG);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { box: [r(i * AREA_DEG), r(j * AREA_DEG), r((i + 1) * AREA_DEG), r((j + 1) * AREA_DEG)], key: `lidar-area:${i}:${j}` };
}

/** The largest box an area job takes, degrees a side (about 3 km): bounds the downloads one job can start. */
const MAX_AREA_DEG = 0.03;

/** The lidar-area job: the area's leaf-off tiles into the tile cache. A malformed box is dropped (never retried). */
export async function runLidarAreaJob(deps: AppDeps, box: unknown): Promise<void> {
  if (!lidarOn(deps)) return;
  if (!Array.isArray(box) || box.length !== 4 || !box.every((v) => typeof v === 'number' && Number.isFinite(v))) return;
  const [w, s, e, n] = box as [number, number, number, number];
  if (!(e > w && n > s && e - w <= MAX_AREA_DEG && n - s <= MAX_AREA_DEG && Math.abs(s) <= 85 && Math.abs(n) <= 85)) return;
  await deps.usgsLidar!.prefetchArea([w, s], [e, n], { maxPoints: 16, maxTiles: 4 });
}

/** A snapshot made while the lidar was still being fetched (USGS_LIDAR_MODE on): not shared from the roof cache. */
export function lidarWasPending(deps: AppDeps, snapshot: { lidar?: Roof3dLidarNote }): boolean {
  return lidarModeOf(deps) === 'on' && lidarOn(deps) && snapshot.lidar?.status === 'none' && snapshot.lidar.reason === 'lidar-pending';
}

/**
 * Whether a kept snapshot should be made again because the lidar it waited for is now ready (mode on only; a quick
 * read of the kept product, no USGS call). While the lidar is still pending the kept roof is reused: making it again
 * would buy Google's layers again for nothing.
 */
export async function lidarNowReady(deps: AppDeps, snapshot: { lidar?: Roof3dLidarNote }, point: LngLat): Promise<boolean> {
  if (!lidarWasPending(deps, snapshot)) return false;
  const known = await deps.usgsLidar!.known(point).catch(() => null);
  return known !== null && 'crop' in known;
}