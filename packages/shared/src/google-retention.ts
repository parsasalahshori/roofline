/*
 * Google content retention (docs/compliance/google-data-retention.md). Raw content from Google Maps Platform (Solar
 * buildingInsights and Data Layers, the true-ortho photo cut from them, Street View images) may be kept at most 30
 * consecutive days from download (Solar API: Service Specific Terms B.20.2; Street View and Map Tiles: no caching at
 * all beyond what the terms allow). Our own measurements worked out from it (outline, faces, pitch numbers, window
 * sizes) are kept.
 *
 * Every stored delete-by date is download + GOOGLE_CONTENT_MAX_DAYS (the most the terms allow). A deployment may keep
 * content for fewer days (GOOGLE_CONTENT_RETENTION_DAYS): the sweep then treats a row as due that many days early
 * (retentionCutoff), so the stored dates never need rewriting when the setting changes.
 */

/** The most days Google content may be kept (Solar API terms: "up to 30 consecutive calendar days"). */
export const GOOGLE_CONTENT_MAX_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * GOOGLE_CONTENT_RETENTION_DAYS as a whole number of days in 1..GOOGLE_CONTENT_MAX_DAYS. Unset or blank: the maximum.
 * Anything else (not a whole number, below 1, above the maximum) is an error: a typo must not keep content longer.
 */
export function parseRetentionDays(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return GOOGLE_CONTENT_MAX_DAYS;
  const n = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > GOOGLE_CONTENT_MAX_DAYS) {
    throw new Error(`GOOGLE_CONTENT_RETENTION_DAYS must be a whole number from 1 to ${GOOGLE_CONTENT_MAX_DAYS}.`);
  }
  return n;
}

/** The date content downloaded at `fetchedAt` must be gone by: fetchedAt + GOOGLE_CONTENT_MAX_DAYS. Null for an unreadable date. */
export function googleDeleteBy(fetchedAt: string | Date | null | undefined): Date | null {
  const at = fetchedAt instanceof Date ? fetchedAt.getTime() : Date.parse(fetchedAt ?? '');
  return Number.isFinite(at) ? new Date(at + GOOGLE_CONTENT_MAX_DAYS * DAY_MS) : null;
}

/**
 * The delete-by date the sweep compares stored dates with, at `now` with `retentionDays` kept: a stored date (download
 * + the maximum) at or before it is due. With the maximum kept it is `now`; with fewer days, later by the difference.
 */
export function retentionCutoff(now: Date, retentionDays: number = GOOGLE_CONTENT_MAX_DAYS): Date {
  const days = parseRetentionDays(retentionDays);
  return new Date(now.getTime() + (GOOGLE_CONTENT_MAX_DAYS - days) * DAY_MS);
}

/** Whether content with stored delete-by `deleteBy` is due at `now` (null or unreadable: due, the strict reading). */
export function googleContentDue(deleteBy: string | Date | null | undefined, now: Date, retentionDays: number = GOOGLE_CONTENT_MAX_DAYS): boolean {
  const at = deleteBy instanceof Date ? deleteBy.getTime() : Date.parse(deleteBy ?? '');
  if (!Number.isFinite(at)) return true;
  return at <= retentionCutoff(now, retentionDays).getTime();
}

/** Whether content downloaded at `downloadedAt` is due at `now` (unreadable: due). */
export function downloadedContentDue(downloadedAt: string | Date | null | undefined, now: Date, retentionDays: number = GOOGLE_CONTENT_MAX_DAYS): boolean {
  return googleContentDue(googleDeleteBy(downloadedAt), now, retentionDays);
}

/**
 * A measurement's delete-by date for the Google content it holds: the earlier of its Solar answer's (buildingInsights)
 * and its 3D roof photo's download + the maximum; null when it holds neither. The roof's own reconstruction is ours and
 * does not count; a 3D snapshot counts only while it still names a photo.
 */
export function measurementGoogleDeleteBy(
  solar: { fetchedAt: string; building?: unknown } | null | undefined,
  roof3d: { fetchedAt: string; photo?: unknown } | null | undefined,
): Date | null {
  const dates: Date[] = [];
  if (solar != null && solar.building != null) {
    const d = googleDeleteBy(solar.fetchedAt);
    if (d !== null) dates.push(d);
  }
  if (roof3d != null && roof3d.photo != null) {
    const d = googleDeleteBy(roof3d.fetchedAt);
    if (d !== null) dates.push(d);
  }
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((d) => d.getTime())));
}

/** Object-store prefixes that hold only Google content (the roof photo cut from Data Layers, Street View photos). */
export const GOOGLE_OBJECT_PREFIXES = ['roof-photos/', 'window-photos/'] as const;

/** What one retention run did. Counts only: never keys, addresses or content. */
export type GoogleRetentionCounts = {
  /** Measurements whose Solar answer and/or roof photo were cleared. */
  measurementsCleared: number;
  /** Roof photo objects deleted (from rows). */
  roofPhotosDeleted: number;
  /** Window measurements whose Street View photos were cleared. */
  windowRowsCleared: number;
  /** Street View photo objects deleted (from rows). */
  windowPhotosDeleted: number;
  /** Objects under a Google prefix with no row naming them (or past the maximum age), deleted. */
  orphansDeleted: number;
  /** Deletes that failed (left for the next run). */
  failures: number;
  /** Companies that could not be swept this run. */
  companiesFailed: number;
};

export function emptyRetentionCounts(): GoogleRetentionCounts {
  return { measurementsCleared: 0, roofPhotosDeleted: 0, windowRowsCleared: 0, windowPhotosDeleted: 0, orphansDeleted: 0, failures: 0, companiesFailed: 0 };
}
