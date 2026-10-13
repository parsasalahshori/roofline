import { sql } from 'drizzle-orm';
import { US_STATE_CODES, type FootprintStateStatus } from '@roofline/shared';
import type { Db } from '../pools.ts';

/*
 * The footprint loader's database side. Runs on the app_system pool (SELECT, INSERT, DELETE on
 * building_footprints; SELECT, INSERT, UPDATE on building_footprint_states;
 * and only id and address_state of companies). Every function takes a two-letter state code and
 * upper-cases it.
 */

export type FootprintInput = { sourceRef: string; ring: readonly (readonly [number, number])[] };

/** A "loading" claim older than this is a crashed worker's, and another job may take it over. */
export const STALE_LOADING_MS = 6 * 60 * 60 * 1000;

const SQ_FT_PER_SQ_M = 10.7639104167;


export async function footprintStateStatus(system: Db, state: string): Promise<FootprintStateStatus | null> {
  const s = state.toUpperCase();
  const result = await system.execute(sql`select status from building_footprint_states where state = ${s}`);
  const row = result.rows[0] as { status: FootprintStateStatus } | undefined;
  return row?.status ?? null;
}

/**
 * Takes the state's load: true when this caller should load it (no row yet, a failed one, or a
 * loading claim older than STALE_LOADING_MS). The state's old building rows are deleted in the
 * same transaction, so a retry never duplicates. False when it is ready or freshly loading.
 */
export async function claimFootprintState(system: Db, state: string, sourceUrl: string, now: Date): Promise<boolean> {
  const s = state.toUpperCase();
  const cutoff = new Date(now.getTime() - STALE_LOADING_MS);
  return system.transaction(async (tx) => {
    const claimed = await tx.execute(sql`
      insert into building_footprint_states (state, status, source_url, started_at, buildings, loaded_at, error_plain)
      values (${s}, 'loading', ${sourceUrl}, ${now}, null, null, null)
      on conflict (state) do update
        set status = 'loading', source_url = excluded.source_url, started_at = excluded.started_at,
            buildings = null, loaded_at = null, error_plain = null
        where building_footprint_states.status = 'failed'
           or (building_footprint_states.status = 'loading' and building_footprint_states.started_at < ${cutoff})
      returning state`);
    if (claimed.rows.length === 0) return false;
    await tx.execute(sql`delete from building_footprints where state = ${s}`);
    return true;
  });
}

function wkt(ring: readonly (readonly [number, number])[]): string {
  return `POLYGON((${ring.map(([lng, lat]) => `${lng} ${lat}`).join(',')}))`;
}

/** Serialises footprint inserts across loads, so two states reading the same tile cannot both store a building. */
const INSERT_LOCK_KEY = 0x6670_6c64; // 'fpld'

/**
 * Inserts one batch; returns how many polygons were stored (invalid or non-polygon results are skipped).
 * A row is skipped as a duplicate when a stored footprint (of any state) or an earlier row of the batch
 * has the same source_ref and the same bounding box: a neighbour state that read the same tile, or a
 * retry. Loaders that key buildings by an outline hash (Global ML) therefore never store one twice.
 */
export async function insertFootprints(system: Db, state: string, batch: readonly FootprintInput[]): Promise<number> {
  const s = state.toUpperCase();
  const usable = batch.filter((f) => f.ring.length >= 4);
  if (usable.length === 0) return 0;
  const values = sql.join(
    usable.map((f, i) => sql`(${i}::int, ${f.sourceRef}::text, ${wkt(f.ring)}::text)`),
    sql`, `,
  );
  return system.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${INSERT_LOCK_KEY}::bigint)`);
    const result = await tx.execute(sql`
      with raw as (
        select v.n, v.source_ref, ST_CollectionExtract(ST_MakeValid(ST_GeomFromText(v.wkt, 4326)), 3) as g
        from (values ${values}) as v(n, source_ref, wkt)
      ), polys as (
        -- Keep only results that are exactly one polygon. The projected value is always a Polygon
        -- (or null, which the filter removes), so the column's Polygon type never rejects a batch.
        select n, source_ref, ST_GeometryN(g, 1) as g from raw where ST_NumGeometries(g) = 1
      ), firsts as (
        select n, source_ref, g,
               row_number() over (partition by source_ref, ST_XMin(g), ST_YMin(g), ST_XMax(g), ST_YMax(g) order by n) as k
        from polys
      ), fresh as (
        select n, source_ref, g from firsts p
        where k = 1
          and not exists (
            select 1 from building_footprints b
            where b.geom && p.g and b.geom ~= p.g and b.source_ref = p.source_ref
          )
      )
      insert into building_footprints (state, geom, area_sq_ft, source, source_ref)
      select ${s}, g, round((ST_Area(g::geography) * ${SQ_FT_PER_SQ_M})::numeric, 1), 'microsoft', source_ref
      from fresh
      order by n
      returning id`);
    return result.rows.length;
  });
}

export async function finishFootprintState(system: Db, state: string, buildings: number, now: Date): Promise<void> {
  const s = state.toUpperCase();
  await system.execute(sql`
    update building_footprint_states
    set status = 'ready', buildings = ${buildings}, loaded_at = ${now}, error_plain = null
    where state = ${s}`);
}

/** Drops the state's partial rows and marks it failed (plain words only, never provider text). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for a uniform signature; started_at stays as it was
export async function failFootprintState(system: Db, state: string, errorPlain: string, _now: Date): Promise<void> {
  const s = state.toUpperCase();
  await system.transaction(async (tx) => {
    await tx.execute(sql`delete from building_footprints where state = ${s}`);
    await tx.execute(sql`
      update building_footprint_states
      set status = 'failed', error_plain = ${errorPlain}, buildings = null, loaded_at = null
      where state = ${s}`);
  });
}

/** One row per state some company is in that has no ready (or fresh loading) footprints, with the smallest such company id. */
export async function statesNeedingFootprintsFor(system: Db): Promise<{ state: string; companyId: string }[]> {
  const cutoff = new Date(Date.now() - STALE_LOADING_MS);
  const codes = sql.join(US_STATE_CODES.map((c) => sql`${c}`), sql`, `);
  const result = await system.execute(sql`
    select upper(trim(c.address_state)) as state, min(c.id::text) as company_id
    from companies c
    where upper(trim(c.address_state)) in (${codes})
      and not exists (
        select 1 from building_footprint_states f
        where f.state = upper(trim(c.address_state))
          and (f.status = 'ready' or (f.status = 'loading' and f.started_at >= ${cutoff}))
      )
    group by upper(trim(c.address_state))
    order by state`);
  return (result.rows as { state: string; company_id: string }[]).map((r) => ({ state: r.state, companyId: r.company_id }));
}

export async function statesNeedingFootprints(system: Db): Promise<string[]> {
  return (await statesNeedingFootprintsFor(system)).map((r) => r.state);
}
