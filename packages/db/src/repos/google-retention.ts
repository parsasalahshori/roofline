import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';
import type { Roof3dSnapshot } from '@roofline/shared';
import { measurements, quoteEstimates, type StoredFacadePhoto, windowMeasurements } from '../schema/index.ts';
import type { TenantContext, Tx } from '../tenant.ts';

/*
 * Google content retention (docs/compliance/google-data-retention.md), run inside withTenant by the google-retention
 * job. A row's Google content is cleared, never the row: a measurement keeps its outline, faces, pitch and totals, a
 * window measurement its walls, windows and sizes. Every statement is scoped to the company (RLS too) and bounded by a
 * limit; running any of them again finds nothing more to do.
 */

/** A measurement holding a Solar answer (the building, not "none there") or a roof photo. */
const measurementHasGoogle = sql`(jsonb_typeof(${measurements.solar}->'building') = 'object' OR jsonb_typeof(${measurements.roof3d}->'photo') = 'object')`;

/** An ISO date text in a jsonb field as a timestamp, else the row's created_at (a garbled date is not trusted). */
function stamp(field: ReturnType<typeof sql>, createdAt: typeof measurements.createdAt | typeof windowMeasurements.createdAt) {
  return sql`CASE WHEN (${field}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (${field})::timestamptz ELSE ${createdAt} END`;
}

/**
 * Sets google_delete_by on up to `limit` of the company's measurements that hold Google content but have no date yet
 * (rows made before the column existed): the earlier of the Solar answer's and the roof photo's download (fetchedAt,
 * else created_at) + `maxDays`. Returns how many it set.
 */
export async function backfillMeasurementGoogleDeleteBy(tx: Tx, ctx: TenantContext, opts: { maxDays: number; limit: number }): Promise<number> {
  const days = sql`make_interval(days => ${opts.maxDays})`;
  const solarAt = sql`CASE WHEN jsonb_typeof(${measurements.solar}->'building') = 'object' THEN ${stamp(sql`${measurements.solar}->>'fetchedAt'`, measurements.createdAt)} + ${days} END`;
  const photoAt = sql`CASE WHEN jsonb_typeof(${measurements.roof3d}->'photo') = 'object' THEN ${stamp(sql`${measurements.roof3d}->>'fetchedAt'`, measurements.createdAt)} + ${days} END`;
  const due = tx
    .select({ id: measurements.id })
    .from(measurements)
    .where(and(eq(measurements.companyId, ctx.companyId), sql`${measurements.googleDeleteBy} IS NULL`, measurementHasGoogle))
    .limit(opts.limit);
  const rows = await tx
    .update(measurements)
    .set({ googleDeleteBy: sql`LEAST(${solarAt}, ${photoAt})` })
    .where(and(eq(measurements.companyId, ctx.companyId), sql`${measurements.id} IN (${due})`))
    .returning({ id: measurements.id });
  return rows.length;
}

export type DueMeasurement = { id: string; photoKey: string | null };

/** Up to `limit` of the company's measurements whose Google content is due (google_delete_by at or before `cutoff`), oldest first. */
export async function measurementsWithDueGoogle(tx: Tx, ctx: TenantContext, opts: { cutoff: Date; limit: number }): Promise<DueMeasurement[]> {
  const rows = await tx
    .select({ id: measurements.id, roof3d: measurements.roof3d })
    .from(measurements)
    .where(and(eq(measurements.companyId, ctx.companyId), isNotNull(measurements.googleDeleteBy), lte(measurements.googleDeleteBy, opts.cutoff)))
    .orderBy(asc(measurements.googleDeleteBy), asc(measurements.id))
    .limit(opts.limit);
  return rows.map((r) => ({ id: r.id, photoKey: photoKeyOf(r.roof3d) }));
}

function photoKeyOf(snapshot: Roof3dSnapshot | null): string | null {
  const key = snapshot?.photo?.key;
  return typeof key === 'string' && key !== '' ? key : null;
}

/**
 * Clears one measurement's Google content: the Solar answer (solar, null: a later Measure asks Google again) and the
 * roof photo's entry in roof_3d (replaced by photoDeletedAt = `now`, so the roof view can say it expired). The 3D roof
 * itself (roof, shadowRoof, lidar note, versions) and every measured number stay. google_delete_by goes null.
 * Call after the photo's object is deleted. Returns whether the row was changed.
 */
export async function clearMeasurementGoogle(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const rows = await tx
    .update(measurements)
    .set({
      solar: null,
      roof3d: sql`CASE WHEN jsonb_typeof(${measurements.roof3d}->'photo') = 'object'
        THEN (${measurements.roof3d} - 'photo') || jsonb_build_object('photoDeletedAt', ${at}::text)
        ELSE ${measurements.roof3d} END`,
      googleDeleteBy: null,
    })
    .where(and(eq(measurements.companyId, ctx.companyId), eq(measurements.id, id)))
    .returning({ id: measurements.id });
  return rows.length > 0;
}

/** A window measurement photo entry that still names stored bytes. */
const photoHasKey = sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${windowMeasurements.photos}) AS p WHERE jsonb_typeof(p->'key') = 'string')`;

/**
 * Sets photos_delete_by on up to `limit` of the company's window measurements that still hold a Street View photo but
 * have no date: the earliest photo deleteBy, else created_at + `maxDays`. Returns how many it set.
 */
export async function backfillWindowPhotosDeleteBy(tx: Tx, ctx: TenantContext, opts: { maxDays: number; limit: number }): Promise<number> {
  const earliest = sql`(SELECT min(CASE WHEN (p->>'deleteBy') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN (p->>'deleteBy')::timestamptz END)
    FROM jsonb_array_elements(${windowMeasurements.photos}) AS p WHERE jsonb_typeof(p->'key') = 'string')`;
  const due = tx
    .select({ id: windowMeasurements.id })
    .from(windowMeasurements)
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), sql`${windowMeasurements.photosDeleteBy} IS NULL`, photoHasKey))
    .limit(opts.limit);
  const rows = await tx
    .update(windowMeasurements)
    .set({ photosDeleteBy: sql`COALESCE(${earliest}, ${windowMeasurements.createdAt} + make_interval(days => ${opts.maxDays}))` })
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), sql`${windowMeasurements.id} IN (${due})`))
    .returning({ id: windowMeasurements.id });
  return rows.length;
}

export type DueWindowPhotos = { id: string; keys: string[] };

/** Up to `limit` of the company's window measurements whose Street View photos are due (photos_delete_by at or before `cutoff`). */
export async function windowPhotosDue(tx: Tx, ctx: TenantContext, opts: { cutoff: Date; limit: number }): Promise<DueWindowPhotos[]> {
  const rows = await tx
    .select({ id: windowMeasurements.id, photos: windowMeasurements.photos })
    .from(windowMeasurements)
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), isNotNull(windowMeasurements.photosDeleteBy), lte(windowMeasurements.photosDeleteBy, opts.cutoff)))
    .orderBy(asc(windowMeasurements.photosDeleteBy), asc(windowMeasurements.id))
    .limit(opts.limit);
  return rows.map((r) => ({ id: r.id, keys: (r.photos as StoredFacadePhoto[]).flatMap((p) => (typeof p.key === 'string' && p.key !== '' ? [p.key] : [])) }));
}

/**
 * Clears one window measurement's Street View photos: each photo entry keeps its numbers (heading, wall line-up, the
 * person's fit) but its key goes null and deletedAt is set to `now`; photos_delete_by goes null. Marked windows,
 * sizes, uploads (the company's own photos) and adjustments stay. Call after the objects are deleted.
 */
export async function clearWindowPhotos(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const rows = await tx
    .update(windowMeasurements)
    .set({
      photos: sql`COALESCE((SELECT jsonb_agg(CASE WHEN jsonb_typeof(e.p->'key') = 'string'
          THEN e.p || jsonb_build_object('key', NULL, 'deletedAt', ${at}::text) ELSE e.p END ORDER BY e.ord)
        FROM jsonb_array_elements(${windowMeasurements.photos}) WITH ORDINALITY AS e(p, ord)), '[]'::jsonb)`,
      photosDeleteBy: null,
    })
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), eq(windowMeasurements.id, id)))
    .returning({ id: windowMeasurements.id });
  return rows.length > 0;
}

/**
 * Clears the result of up to `limit` of the company's instant-quote estimates made at or before `createdAtOrBefore` (the
 * retention days ago): the result holds what Google Solar gave (the imagery's quality and date, the roof outline, the roof and
 * window ranges worked out from it). The row stays (requests point at it, and it counts toward the daily cap); its
 * result keeps only why it was a call back and the address lookup, and gets googleClearedAt = `now`. An estimate is not
 * reused past its own 30 days, so nothing live reads what goes. Returns how many it cleared; a cleared row is skipped.
 */
export async function clearExpiredQuoteEstimates(tx: Tx, ctx: TenantContext, opts: { createdAtOrBefore: Date; now: Date; limit: number }): Promise<number> {
  const at = opts.now.toISOString();
  const due = tx
    .select({ id: quoteEstimates.id })
    .from(quoteEstimates)
    .where(and(eq(quoteEstimates.companyId, ctx.companyId), lte(quoteEstimates.createdAt, opts.createdAtOrBefore), sql`NOT (${quoteEstimates.result} ? 'googleClearedAt')`))
    .orderBy(asc(quoteEstimates.createdAt), asc(quoteEstimates.id))
    .limit(opts.limit);
  const rows = await tx
    .update(quoteEstimates)
    .set({
      result: sql`jsonb_build_object('roof', 'null'::jsonb, 'windows', 'null'::jsonb, 'gutters', 'null'::jsonb, 'outline', 'null'::jsonb, 'googleClearedAt', ${at}::text)
        || CASE WHEN ${quoteEstimates.result} ? 'callback' THEN jsonb_build_object('callback', ${quoteEstimates.result}->'callback') ELSE '{}'::jsonb END
        || CASE WHEN ${quoteEstimates.result} ? 'lookup' THEN jsonb_build_object('lookup', ${quoteEstimates.result}->'lookup') ELSE '{}'::jsonb END`,
    })
    .where(and(eq(quoteEstimates.companyId, ctx.companyId), sql`${quoteEstimates.id} IN (${due})`))
    .returning({ id: quoteEstimates.id });
  return rows.length;
}

/** Every object key of Google content the company's rows still name (roof photos, Street View photos). */
export async function googleObjectKeysInUse(tx: Tx, ctx: TenantContext): Promise<string[]> {
  const roof = await tx
    .select({ key: sql<string>`${measurements.roof3d}->'photo'->>'key'` })
    .from(measurements)
    .where(and(eq(measurements.companyId, ctx.companyId), sql`jsonb_typeof(${measurements.roof3d}->'photo'->'key') = 'string'`));
  const windows = await tx
    .select({ key: sql<string>`p->>'key'` })
    .from(sql`${windowMeasurements}, jsonb_array_elements(${windowMeasurements.photos}) AS p`)
    .where(and(eq(windowMeasurements.companyId, ctx.companyId), sql`jsonb_typeof(p->'key') = 'string'`));
  return [...roof, ...windows].map((r) => r.key);
}
