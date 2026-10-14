import { sql } from 'drizzle-orm';
import type { FootprintStateStatus } from '@roofline/shared';
import type { Db } from '../pools.ts';

/*
 * The footprint loader's database side. Runs on the app_system pool (SELECT, INSERT, DELETE on
 * building_footprints; SELECT, INSERT, UPDATE on building_footprint_tiles; and only id of companies).
 *
 * Footprints are loaded one tile at a time: a zoom-9 Bing quadkey of Microsoft's Global ML Building
 * Footprints (about 70 km on a side in the US). Each tile has one building_footprint_tiles row, and
 * its buildings carry the quadkey in building_footprints.tile. The older per-state table,
 * building_footprint_states, is no longer written (its source stopped serving files).
 */

export type FootprintInput = { sourceRef: string; ring: readonly (readonly [number, number])[] };
/** Where loaded rows belong: their tile (null for seeded rows) and their state, when known. */
export type FootprintTarget = { tile: string | null; state: string | null };
export type FootprintTileStatus = FootprintStateStatus;

/** A "loading" claim older than this is a crashed worker's, and another job may take it over. */
export const STALE_LOADING_MS = 6 * 60 * 60 * 1000;

const SQ_FT_PER_SQ_M = 10.7639104167;

/** Each named tile's status; a tile with no row is missing from the map. */
export async function footprintTileStatuses(system: Db, quadkeys: readonly string[]): Promise<Map<string, FootprintTileStatus>> {
  const out = new Map<string, FootprintTileStatus>();
  if (quadkeys.length === 0) return out;
  const keys = sql.join(quadkeys.map((q) => sql`${q}`), sql`, `);
  const result = await system.execute(sql`select quadkey, status from building_footprint_tiles where quadkey in (${keys})`);
  for (const row of result.rows as { quadkey: string; status: FootprintTileStatus }[]) out.set(row.quadkey, row.status);
  return out;
}

export async function footprintTileStatus(system: Db, quadkey: string): Promise<FootprintTileStatus | null> {
  return (await footprintTileStatuses(system, [quadkey])).get(quadkey) ?? null;
}

/**
 * Takes the tile's load: true when this caller should load it (no row yet, a failed one, or a loading
 * claim older than STALE_LOADING_MS). The tile's old building rows are deleted in the same
 * transaction, so a retry never duplicates. False when it is ready or freshly loading.
 */
export async function claimFootprintTile(system: Db, quadkey: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - STALE_LOADING_MS);
  return system.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      insert into building_footprint_tiles (quadkey, status, source_url, started_at, buildings, loaded_at, error_plain)
      values (${quadkey}, 'loading', null, ${now}, null, null, null)
      on conflict (quadkey) do update
        set status = 'loading', source_url = null, started_at = excluded.started_at,
            buildings = null, loaded_at = null, error_plain = null
        where building_footprint_tiles.status = 'failed'
           or (building_footprint_tiles.status = 'loading' and building_footprint_tiles.started_at < ${cutoff})
      returning quadkey`);
    if (claimed.rows.length === 0) return false;
    await tx.execute(sql`delete from building_footprints where tile = ${quadkey}`);
    return true;
  });
}

function wkt(ring: readonly (readonly [number, number])[]): string {
  return `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(',')}))`;
}

/** Inserts one batch; returns how many polygons were stored (invalid or non-polygon results are skipped). */
export async function insertFootprints(system: Db, target: FootprintTarget, batch: readonly FootprintInput[]): Promise<number> {
  const state = target.state === null ? null : target.state.trim().toUpperCase();
  const usable = batch.filter((f) => f.ring.length >= 4);
  if (usable.length === 0) return 0;
  const values = sql.join(
    usable.map((f) => sql`(${f.sourceRef}::text, ${wkt(f.ring)}::text)`),
    sql`, `,
  );
  const result = await system.execute(sql`
    with raw as (
      select v.source_ref, ST_CollectionExtract(ST_MakeValid(ST_GeomFromText(v.wkt, 4326)), 3) as g
      from (values ${values}) as v(source_ref, wkt)
    ), polys as (
      -- Keep only results that are exactly one polygon. The projected value is always a Polygon
      -- (or null, which the filter removes), so the column's Polygon type never rejects a batch.
      select source_ref, ST_GeometryN(g, 1) as g from raw where ST_NumGeometries(g) = 1
    )
    insert into building_footprints (state, tile, geom, area_sq_ft, source, source_ref)
    select ${state}::char(2), ${target.tile}::text, g, round((ST_Area(g::geography) * ${SQ_FT_PER_SQ_M})::numeric, 1), 'microsoft', source_ref
    from polys
    returning id`);
  return result.rows.length;
}

export async function finishFootprintTile(system: Db, quadkey: string, buildings: number, sourceUrl: string | null, now: Date): Promise<void> {
  await system.execute(sql`
    update building_footprint_tiles
    set status = 'ready', buildings = ${buildings}, source_url = ${sourceUrl}, loaded_at = ${now}, error_plain = null
    where quadkey = ${quadkey}`);
}

/** Drops the tile's partial rows and marks it failed (plain words only, never provider text). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for a uniform signature; started_at stays as it was
export async function failFootprintTile(system: Db, quadkey: string, errorPlain: string, _now: Date): Promise<void> {
  await system.transaction(async (tx) => {
    await tx.execute(sql`delete from building_footprints where tile = ${quadkey}`);
    await tx.execute(sql`
      update building_footprint_tiles
      set status = 'failed', error_plain = ${errorPlain}, buildings = null, loaded_at = null
      where quadkey = ${quadkey}`);
  });
}

/**
 * Tiles worth another try: failed ones, and loading claims older than STALE_LOADING_MS (a crashed
 * worker's). Each comes with the smallest company id, because every job carries one; with no company
 * at all nothing is listed.
 */
export async function tilesNeedingRetry(system: Db, now: Date): Promise<{ quadkey: string; companyId: string }[]> {
  const cutoff = new Date(now.getTime() - STALE_LOADING_MS);
  const result = await system.execute(sql`
    select t.quadkey, (select min(c.id::text) from companies c) as company_id
    from building_footprint_tiles t
    where t.status = 'failed' or (t.status = 'loading' and t.started_at < ${cutoff})
    order by t.quadkey`);
  return (result.rows as { quadkey: string; company_id: string | null }[])
    .filter((r) => r.company_id !== null)
    .map((r) => ({ quadkey: r.quadkey, companyId: r.company_id! }));
}
