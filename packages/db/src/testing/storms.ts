/*
 * Storm Scout test fixtures (S1 Task 9): storm geometries over the Omaha showcase and a second city
 * (Lincoln), service areas, properties and small building footprints. Plain SQL through a `Query`
 * function, so the same helpers serve packages/db tests (pg owner pool) and apps/api tests.
 * E1's seedFootprintFixture / footprints-*.json fixtures are not on this base, so footprints are
 * generated here. All coordinates are WGS84 [lng, lat].
 */

/** Runs one SQL statement as a role that can write every table (the owner) and returns the rows. */
export type Query = (text: string, values?: unknown[]) => Promise<Record<string, unknown>[]>;

/** A rectangle as [west, south, east, north]. */
export type Box = [west: number, south: number, east: number, north: number];

export type GeoJsonMultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };

/** Omaha showcase service area. */
export const OMAHA_BOX: Box = [-96.0, 41.2, -95.85, 41.32];
/** Lincoln, the second city. */
export const LINCOLN_BOX: Box = [-96.8, 40.75, -96.6, 40.88];

/** Hail contours of the Omaha fixture storm: each box nests inside the one before it. */
export const OMAHA_CONTOURS: { thresholdIn: number; box: Box }[] = [
  { thresholdIn: 0.75, box: [-96.05, 41.15, -95.8, 41.35] },
  { thresholdIn: 1.0, box: [-95.98, 41.2, -95.87, 41.3] },
  { thresholdIn: 1.5, box: [-95.95, 41.22, -95.9, 41.28] },
];

/** Hail contours of the Lincoln fixture storm. */
export const LINCOLN_CONTOURS: { thresholdIn: number; box: Box }[] = [
  { thresholdIn: 0.75, box: [-96.85, 40.7, -96.55, 40.92] },
  { thresholdIn: 1.0, box: [-96.78, 40.76, -96.62, 40.86] },
];

/** A point in the 1.5 inch contour of the Omaha storm (and in the Omaha service area). */
export const OMAHA_CORE: [number, number] = [-95.925, 41.25];
/** A point in the 1.0 inch contour but outside the 1.5 inch one. */
export const OMAHA_MIDDLE: [number, number] = [-95.96, 41.21];
/** A point in the 0.75 inch contour but outside the 1.0 inch one, still inside the Omaha service area. */
export const OMAHA_EDGE: [number, number] = [-95.99, 41.31];
/** A point far from every fixture storm. */
export const FAR_AWAY: [number, number] = [-100.0, 35.0];

export function boxWkt([w, s, e, n]: Box): string {
  return `POLYGON((${w} ${s}, ${e} ${s}, ${e} ${n}, ${w} ${n}, ${w} ${s}))`;
}

export function boxToGeoJson([w, s, e, n]: Box): GeoJsonMultiPolygon {
  return {
    type: 'MultiPolygon',
    coordinates: [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]],
  };
}

export type FixtureStormInput = {
  /** 'YYYY-MM-DD' */
  convectiveDay: string;
  status?: 'provisional' | 'final';
  /** Contours, lowest threshold first; the lowest one is also the storm's geom_075 and bbox. */
  contours: { thresholdIn: number; box: Box }[];
  /** Defaults to the highest contour threshold. */
  maxIn?: number;
  finalAt?: Date | null;
};

/** Inserts a storm and its contours; returns the storm id. */
export async function insertFixtureStorm(q: Query, input: FixtureStormInput): Promise<string> {
  const first = input.contours[0]!;
  const maxIn = input.maxIn ?? Math.max(...input.contours.map((c) => c.thresholdIn));
  const [w, s, e, n] = first.box;
  const rows = await q(
    `insert into storms (convective_day, status, max_in, geom_075, bbox, centroid, final_at)
     values ($1, $2, $3,
       ST_Multi(ST_GeomFromText($4, 4326)), ST_GeomFromText($4, 4326),
       ST_SetSRID(ST_MakePoint($5, $6), 4326), $7)
     returning id`,
    [input.convectiveDay, input.status ?? 'provisional', maxIn, boxWkt(first.box), (w + e) / 2, (s + n) / 2, input.finalAt ?? null],
  );
  const stormId = rows[0]!.id as string;
  for (const c of input.contours) {
    await q(
      `insert into storm_contours (storm_id, threshold_in, geom) values ($1, $2, ST_Multi(ST_GeomFromText($3, 4326)))`,
      [stormId, c.thresholdIn, boxWkt(c.box)],
    );
  }
  return stormId;
}

export const insertOmahaStorm = (q: Query, convectiveDay: string, status: 'provisional' | 'final' = 'provisional') =>
  insertFixtureStorm(q, { convectiveDay, status, contours: OMAHA_CONTOURS });

export const insertLincolnStorm = (q: Query, convectiveDay: string, status: 'provisional' | 'final' = 'provisional') =>
  insertFixtureStorm(q, { convectiveDay, status, contours: LINCOLN_CONTOURS });

/** Sets (or clears with null) a company's service area. */
export async function setFixtureServiceArea(q: Query, companyId: string, box: Box | null): Promise<void> {
  await q(
    `update companies set service_area = ${box === null ? 'null' : 'ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON($2)), 4326)'} where id = $1`,
    box === null ? [companyId] : [companyId, JSON.stringify(boxToGeoJson(box))],
  );
}

/** Sets the company's hail threshold (company_settings row is created if the seed has none). */
export async function setFixtureThreshold(q: Query, companyId: string, thresholdIn: number): Promise<void> {
  await q(
    `insert into company_settings (company_id, hail_threshold_in) values ($1, $2)
     on conflict (company_id) do update set hail_threshold_in = excluded.hail_threshold_in`,
    [companyId, thresholdIn],
  );
}

let sequence = 0;

/** Inserts a customer and a property at `at`; returns both ids. `withCustomer: false` makes a property with no customer. */
export async function insertFixtureProperty(
  q: Query,
  companyId: string,
  at: [number, number],
  opts: { withCustomer?: boolean; archived?: boolean } = {},
): Promise<{ propertyId: string; customerId: string | null }> {
  sequence += 1;
  let customerId: string | null = null;
  if (opts.withCustomer !== false) {
    const c = await q(`insert into customers (company_id, display_name) values ($1, $2) returning id`, [companyId, `Fixture customer ${sequence}`]);
    customerId = c[0]!.id as string;
  }
  const line = `${100 + sequence} Fixture St`;
  const p = await q(
    `insert into properties (company_id, customer_id, address_line, city, state, zip, address_key, geom, archived_at)
     values ($1, $2, $3, 'Omaha', 'NE', '68102', $4, ST_SetSRID(ST_MakePoint($5, $6), 4326), $7) returning id`,
    [companyId, customerId, line, `${line.toLowerCase()}|68102`, at[0], at[1], opts.archived === true ? new Date() : null],
  );
  return { propertyId: p[0]!.id as string, customerId };
}

/** Inserts one small square footprint (about 10 m) centred on `at`; returns its id. */
export async function insertFixtureFootprint(q: Query, at: [number, number], state = 'NE'): Promise<number> {
  sequence += 1;
  const d = 0.00005;
  const box: Box = [at[0] - d, at[1] - d, at[0] + d, at[1] + d];
  const rows = await q(
    `insert into building_footprints (state, geom, area_sq_ft, source, source_ref)
     values ($1, ST_GeomFromText($2, 4326), 1000, 'fixture', $3) returning id`,
    [state, boxWkt(box), `fixture-${sequence}`],
  );
  return Number(rows[0]!.id);
}
