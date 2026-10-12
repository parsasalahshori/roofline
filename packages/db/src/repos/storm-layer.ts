import { sql } from 'drizzle-orm';
import type { Tx } from '../tenant.ts';

/** A GeoJSON Feature, as the map layer sends it. */
export type LayerFeature = {
  type: 'Feature';
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
};
export type LayerFeatureCollection = { type: 'FeatureCollection'; features: LayerFeature[] };

export type StormLayerInput = {
  /** [west, south, east, north] in degrees. */
  bbox: [number, number, number, number];
  /** Storms from the last N days (by convective day, against the clock `now`). */
  days: number;
  /** Map zoom; picks the simplification tolerance. */
  zoom: number;
  /** The app clock's now (defaults to new Date() if left out). */
  now?: Date;
};

export type StormLayer = {
  swaths: LayerFeatureCollection;
  spots: LayerFeatureCollection;
  newestRunAt: Date | null;
};

/** Simplification tolerance in degrees for a map zoom: the closer in, the finer the outline. */
export function simplifyTolerance(zoom: number): number {
  if (zoom <= 5) return 0.02;
  if (zoom <= 7) return 0.01;
  if (zoom <= 9) return 0.004;
  if (zoom <= 11) return 0.0015;
  return 0.0005;
}

const SPOT_CAP = 2000;

type SwathRow = {
  storm_id: string;
  threshold_in: string | number;
  max_in: string | number;
  convective_day: string;
  status: string;
  place_name: string | null;
  geometry: LayerFeature['geometry'];
};

type SpotRow = {
  id: string | number;
  report_date: string;
  time_utc: string;
  size_in: string | number;
  location: string | null;
  county: string | null;
  state: string;
  geometry: LayerFeature['geometry'];
};

/** Hail swaths and spotter reports in the box, and when the newest radar run was processed. */
export async function stormLayer(tx: Tx, input: StormLayerInput): Promise<StormLayer> {
  const [west, south, east, north] = input.bbox;
  const cutoff = new Date((input.now ?? new Date()).getTime() - input.days * 86_400_000).toISOString().slice(0, 10);
  const envelope = sql`ST_MakeEnvelope(${west}::float8, ${south}::float8, ${east}::float8, ${north}::float8, 4326)`;
  const tolerance = simplifyTolerance(input.zoom);

  const swathRows = await tx.execute<SwathRow>(sql`
    select s.id as storm_id, c.threshold_in, s.max_in, s.convective_day::text as convective_day, s.status, s.place_name,
           ST_AsGeoJSON(ST_SimplifyPreserveTopology(c.geom, ${tolerance}::float8))::json as geometry
    from storms s
    join storm_contours c on c.storm_id = s.id
    where s.convective_day >= ${cutoff}::date
      and ST_Intersects(s.geom_075, ${envelope})
      and ST_Intersects(c.geom, ${envelope})
    order by s.convective_day desc, s.id, c.threshold_in asc
  `);

  const spotRows = await tx.execute<SpotRow>(sql`
    select id, report_date::text as report_date, time_utc::text as time_utc, size_in, location, county, state,
           ST_AsGeoJSON(geom)::json as geometry
    from spotter_reports
    where report_date >= ${cutoff}::date and ST_Intersects(geom, ${envelope})
    order by report_date desc, time_utc desc, id desc
    limit ${SPOT_CAP}
  `);

  const runRows = await tx.execute<{ newest: string | Date | null }>(
    sql`select max(processed_at) as newest from hail_runs where status = 'processed'`,
  );
  const newest = runRows.rows[0]?.newest ?? null;

  return {
    swaths: {
      type: 'FeatureCollection',
      features: swathRows.rows.map((r) => ({
        type: 'Feature',
        geometry: r.geometry,
        properties: {
          stormId: r.storm_id,
          thresholdIn: Number(r.threshold_in),
          maxIn: Number(r.max_in),
          convectiveDay: r.convective_day,
          status: r.status,
          placeName: r.place_name,
          label: 'Radar-estimated',
        },
      })),
    },
    spots: {
      type: 'FeatureCollection',
      features: spotRows.rows.map((r) => ({
        type: 'Feature',
        geometry: r.geometry,
        properties: {
          id: Number(r.id),
          reportDate: r.report_date,
          timeUtc: r.time_utc,
          sizeIn: Number(r.size_in),
          location: r.location,
          county: r.county,
          state: r.state,
        },
      })),
    },
    newestRunAt: newest === null ? null : new Date(newest),
  };
}
