import {
  backfillMeasurementGoogleDeleteBy,
  backfillWindowPhotosDeleteBy,
  clearMeasurementGoogle,
  clearWindowPhotos,
  googleObjectKeysInUse,
  measurementsWithDueGoogle,
  type TenantContext,
  windowPhotosDue,
  withTenant,
} from '@roofline/db';
import {
  downloadedContentDue,
  GOOGLE_CONTENT_MAX_DAYS,
  GOOGLE_OBJECT_PREFIXES,
  type GoogleRetentionCounts,
  parseRetentionDays,
  retentionCutoff,
} from '@roofline/shared';
import type { AppDeps } from '../app.ts';

/*
 * Google content retention (docs/compliance/google-data-retention.md). Deletes, in batches, the Google content the app
 * stores once it is past GOOGLE_CONTENT_RETENTION_DAYS (at most 30) from download:
 *  - a measurement's Solar answer (measurements.solar, buildingInsights as parsed) and its roof photo (the PNG cut from
 *    Data Layers' RGB, object `roof-photos/...`, named by measurements.roof_3d.photo);
 *  - a window measurement's Street View photos (objects `window-photos/...`, named by window_measurements.photos);
 *  - any object under those prefixes no row names (an orphan: a Measure that stored a photo and then failed).
 * Kept: every number we worked out (outline, 3D faces and lines, pitch, totals, window boxes and sizes, wall line-ups)
 * and the company's own uploaded window photos. Raw Data Layers GeoTIFFs and buildingInsights JSON are never stored
 * (they live in this process for minutes: roof-3d.ts, solar.ts).
 *
 * Idempotent: a cleared row has no delete-by date and no key, a deleted object is gone; a failed delete leaves its row
 * as it was for the next run. Logs counts only, never keys, addresses or content.
 */

const BATCH = 200;
/** An object no row names is left this long first: a Measure may have stored it and not saved its row yet. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

export type SweepOptions = { batch?: number };

function systemCtx(companyId: string): TenantContext {
  return { companyId, role: 'system', userId: null, canApproveSpend: false };
}

/** The configured days, 1..30 (unset: 30). */
export function retentionDaysOf(deps: Pick<AppDeps, 'config'>): number {
  return parseRetentionDays((deps.config as { GOOGLE_CONTENT_RETENTION_DAYS?: number }).GOOGLE_CONTENT_RETENTION_DAYS);
}

/** Deletes an object; false when the store refused (left for the next run). */
async function deleteObject(deps: AppDeps, key: string): Promise<boolean> {
  try {
    await deps.objectStore.delete(key);
    return true;
  } catch {
    return false;
  }
}

/** One company: backfill missing dates, then clear what is due. Adds to `counts`; returns the keys its rows still name. */
export async function sweepCompanyGoogle(deps: AppDeps, companyId: string, now: Date, counts: GoogleRetentionCounts, o: SweepOptions = {}): Promise<string[]> {
  const ctx = systemCtx(companyId);
  const batch = o.batch ?? BATCH;
  const cutoff = retentionCutoff(now, retentionDaysOf(deps));
  const storeOn = deps.objectStore.configured;

  // Rows made before the delete-by dates existed (or before this job): dated from their download, else created_at.
  for (;;) {
    const n = await withTenant(deps.pools, ctx, (tx) => backfillMeasurementGoogleDeleteBy(tx, ctx, { maxDays: GOOGLE_CONTENT_MAX_DAYS, limit: batch }));
    if (n < batch) break;
  }
  for (;;) {
    const n = await withTenant(deps.pools, ctx, (tx) => backfillWindowPhotosDeleteBy(tx, ctx, { maxDays: GOOGLE_CONTENT_MAX_DAYS, limit: batch }));
    if (n < batch) break;
  }

  // Measurements: the roof photo's object first, then the row (a row is cleared only once its object is gone).
  for (;;) {
    const due = await withTenant(deps.pools, ctx, (tx) => measurementsWithDueGoogle(tx, ctx, { cutoff, limit: batch }));
    let cleared = 0;
    for (const row of due) {
      if (row.photoKey !== null && storeOn) {
        if (!(await deleteObject(deps, row.photoKey))) {
          counts.failures += 1;
          continue;
        }
        counts.roofPhotosDeleted += 1;
      }
      if (await withTenant(deps.pools, ctx, (tx) => clearMeasurementGoogle(tx, ctx, row.id, now))) {
        counts.measurementsCleared += 1;
        cleared += 1;
      }
    }
    if (cleared === 0 || due.length < batch) break;
  }

  // Window measurements: every Street View photo of the row, then the row.
  for (;;) {
    const due = await withTenant(deps.pools, ctx, (tx) => windowPhotosDue(tx, ctx, { cutoff, limit: batch }));
    let cleared = 0;
    for (const row of due) {
      let ok = true;
      if (storeOn) {
        for (const key of row.keys) {
          if (await deleteObject(deps, key)) counts.windowPhotosDeleted += 1;
          else {
            counts.failures += 1;
            ok = false;
          }
        }
      }
      if (!ok) continue;
      if (await withTenant(deps.pools, ctx, (tx) => clearWindowPhotos(tx, ctx, row.id, now))) {
        counts.windowRowsCleared += 1;
        cleared += 1;
      }
    }
    if (cleared === 0 || due.length < batch) break;
  }

  return withTenant(deps.pools, ctx, (tx) => googleObjectKeysInUse(tx, ctx));
}

/**
 * Objects under the Google prefixes that no row names: deleted once older than ORPHAN_GRACE_MS. When some company could
 * not be read (`keysComplete` false) an unnamed object might still be in use, so only those past the retention days
 * themselves go (always safe: such content must be gone whoever names it).
 */
export async function sweepGoogleOrphans(deps: AppDeps, now: Date, inUse: ReadonlySet<string>, keysComplete: boolean, counts: GoogleRetentionCounts): Promise<void> {
  if (!deps.objectStore.configured) return;
  const days = retentionDaysOf(deps);
  for (const prefix of GOOGLE_OBJECT_PREFIXES) {
    const objects = await deps.objectStore.list(prefix);
    for (const obj of objects) {
      if (inUse.has(obj.key)) continue;
      const pastDays = downloadedContentDue(obj.lastModified, now, days);
      const pastGrace = now.getTime() - obj.lastModified.getTime() >= ORPHAN_GRACE_MS;
      if (!(pastDays || (keysComplete && pastGrace))) continue;
      if (await deleteObject(deps, obj.key)) counts.orphansDeleted += 1;
      else counts.failures += 1;
    }
  }
}
