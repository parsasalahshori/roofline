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

/** The lidar for the roof at `point`: null when lidar is off; else the note and, with mode on and a crop, the points. */
export async function lidarForRoof(deps: AppDeps, point: LngLat, imageryDate: string | null): Promise<{ points: LidarPointsUtm | null; note: Roof3dLidarNote } | null> {
  if (!lidarOn(deps)) return null;
  const evidence = await deps.usgsLidar!.forMeasure(point);
  const use = lidarModeOf(deps) === 'on' && 'crop' in evidence;
  return { points: use && 'crop' in evidence ? pointsOf(evidence.crop, imageryDate) : null, note: noteOf(evidence, use, imageryDate) };
}

/** Starts fetching the lidar round a searched address (Measure search prefetch). Nothing when lidar is off. */
export function prefetchLidar(deps: AppDeps, point: LngLat): Promise<void> {
  if (!lidarOn(deps)) return Promise.resolve();
  return deps.usgsLidar!.prefetch(point).then(() => undefined);
}

/** A kept snapshot made while the lidar was still being fetched: worth making again once lidar is on. */
export function lidarWasPending(deps: AppDeps, snapshot: { lidar?: Roof3dLidarNote }): boolean {
  return lidarOn(deps) && snapshot.lidar?.status === 'none' && snapshot.lidar.reason === 'lidar-pending';
}
