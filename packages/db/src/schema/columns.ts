import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, check, customType, timestamp, uuid } from 'drizzle-orm/pg-core';

/** `id uuid primary key default gen_random_uuid()`. */
export const pk = () => uuid('id').primaryKey().defaultRandom();

/** `created_at` / `updated_at` as timestamptz. `updated_at` is bumped by Drizzle on every update. */
export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** A nullable timestamptz column. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** Case-insensitive text (the `citext` extension). */
export const citext = customType<{ data: string }>({ dataType: () => 'citext' });

/** Binary data (encrypted credentials). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/** A point as `[longitude, latitude]`, the same tuple order as drizzle's own `geometry` column. */
export type LngLat = [lng: number, lat: number];

/** Parses the hex EWKB that PostGIS returns for a 2-D point (with or without an SRID). */
function parseEwkbPoint(hex: string): LngLat {
  const buf = Buffer.from(hex, 'hex');
  const little = buf[0] === 1;
  const type = little ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
  const offset = type & 0x20000000 ? 9 : 5; // an SRID, when present, sits between the type and the coordinates
  return little
    ? [buf.readDoubleLE(offset), buf.readDoubleLE(offset + 8)]
    : [buf.readDoubleBE(offset), buf.readDoubleBE(offset + 8)];
}

/**
 * `geometry(Point,4326)`. Drizzle's built-in `geometry()` column ignores its `type` and `srid`
 * options and emits an untyped `geometry(point)`, so this custom type is what actually pins the
 * column to WGS84 points. Writes go through `ST_SetSRID(ST_MakePoint(lng, lat), 4326)`.
 */
export const point4326 = customType<{ data: LngLat; driverData: string }>({
  dataType: () => 'geometry(Point,4326)',
  toDriver: (value) => sql`ST_SetSRID(ST_MakePoint(${value[0]}, ${value[1]}), 4326)`,
  fromDriver: parseEwkbPoint,
});

/**
 * `geometry(MultiPolygon,4326)`. Reads come back as the driver's hex EWKB string and writes accept
 * EWKT (`SRID=4326;MULTIPOLYGON(...)`), so callers that need GeoJSON wrap the column in
 * `ST_AsGeoJSON(...)` / `ST_GeomFromGeoJSON(...)` themselves.
 */
export const multiPolygon = customType<{ data: string }>({ dataType: () => 'geometry(MultiPolygon,4326)' });

/** `geometry(Polygon,4326)`: one building footprint (global `building_footprints`). Same EWKT rules as `multiPolygon`. */
export const polygon4326 = customType<{ data: string }>({ dataType: () => 'geometry(Polygon,4326)' });

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A CHECK constraint that limits a text column to the given values. Enum columns are plain `text`
 * (adding a value later is an ordinary migration) and this keeps the database honest.
 * NULL passes, as it does for any CHECK, so nullable enum columns stay nullable.
 */
export function enumCheck(table: string, columnName: string, column: AnyPgColumn, values: readonly string[]) {
  const list: SQL = sql.join(
    values.map((v) => sql.raw(quote(v))),
    sql.raw(', '),
  );
  return check(`${table}_${columnName}_check`, sql`${column} in (${list})`);
}
