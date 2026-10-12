import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import type { StepRow } from '@roofline/db';
import {
  insertFixtureFootprint,
  insertFixtureProperty,
  insertOmahaStorm,
  OMAHA_BOX,
  OMAHA_CORE,
  setFixtureServiceArea,
  setFixtureThreshold,
  type Query,
} from '@roofline/db/testing';
import { buildRoutesHandler } from '../src/storm/routes-build.ts';
import { agentCtx, dbSteps, newTask } from './task-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';

/*
 * The build_routes step (S1 Task 14) against a real database: the homes inside a storm's hail zone become
 * door-knock routes. Footprints are global rows made through the owner connection. These tests need Docker
 * and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const DAY = '2026-10-11';

let owner: pg.Pool;
let t: TestApp;
let companyStormId: string;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

const companyA = () => t.seed.a.companyId;
const repA = () => t.seed.a.rep.userId;
const otherRepA = () => t.seed.a.otherRep.userId;

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  await q('delete from building_footprints');
  await setFixtureServiceArea(q, companyA(), OMAHA_BOX);
  await setFixtureThreshold(q, companyA(), 1.0);
  await q(`update companies set address_city = 'Omaha' where id = $1`, [companyA()]);
  const stormId = await insertOmahaStorm(q, DAY);
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.5, 0, 0) returning id`,
    [companyA(), stormId],
  );
  companyStormId = rows[0]!.id as string;
});

/** Inserts cols x rows tiny squares on a 0.002 degree grid inside the 1.0 inch contour, in one statement. */
async function insertGrid(cols: number, rows: number): Promise<void> {
  await q(
    `insert into building_footprints (state, geom, area_sq_ft, source, source_ref)
     select 'NE',
            ST_MakeEnvelope(x - 0.00005, y - 0.00005, x + 0.00005, y + 0.00005, 4326),
            1000, 'fixture', 'grid-' || i || '-' || j
       from (select i, j, -95.975 + i * 0.002 as x, 41.205 + j * 0.002 as y
               from generate_series(0, $1::int - 1) as i, generate_series(0, $2::int - 1) as j) g`,
    [cols, rows],
  );
}

async function stepFor(payload: Record<string, unknown>): Promise<StepRow> {
  const { taskId } = await newTask(t, 'a', { steps: [{ type: 'build_routes', payload }] });
  return (await dbSteps(t, 'a', taskId))[0]!;
}

async function run(repUserIds: string[], maxDoors: number) {
  const step = await stepFor({ companyStormId, repUserIds, maxDoors });
  return buildRoutesHandler(t.deps, agentCtx(companyA()), step);
}

const routeRows = () =>
  q(`select id, name, stops from door_routes where company_id = $1 order by name, id`, [companyA()]);
const stopRows = () =>
  q(
    `select s.route_id, s.position, s.footprint_id, s.property_id, s.address
       from door_stops s where s.company_id = $1 order by s.route_id, s.position`,
    [companyA()],
  );

describe('build_routes', () => {
  test('plans every home in the hail path once, at most 150 to a route', async () => {
    await insertGrid(20, 16);
    const all = await q('select id from building_footprints');
    expect(all).toHaveLength(320);

    const outcome = await run([repA(), otherRepA()], 1500);
    expect(outcome.status).toBe('done');
    const result = outcome.result as Record<string, unknown>;
    expect(result.doors).toBe(320);

    const perFootprint = await q(
      `select footprint_id, count(*)::int as n from door_stops where company_id = $1 group by 1`,
      [companyA()],
    );
    expect(perFootprint).toHaveLength(320);
    expect(perFootprint.every((r) => r.n === 1)).toBe(true);
    expect(new Set(perFootprint.map((r) => Number(r.footprint_id)))).toEqual(new Set(all.map((r) => Number(r.id))));

    const routes = await routeRows();
    expect(result.routes).toBe(routes.length);
    const stops = await stopRows();
    for (const route of routes) {
      const mine = stops.filter((s) => s.route_id === route.id);
      expect(route.stops as number).toBeLessThanOrEqual(150);
      expect(mine.length).toBe(route.stops);
      expect(mine.length).toBeLessThanOrEqual(150);
      expect(mine.map((s) => s.position)).toEqual(mine.map((_s, i) => i + 1));
    }

    const byRep = result.byRep as { userId: string; doors: number }[];
    expect(byRep.reduce((sum, r) => sum + r.doors, 0)).toBe(result.doors);
    expect(byRep.map((r) => r.userId).sort()).toEqual([repA(), otherRepA()].sort());
  });

  test('customers homes carry property_id and their saved address; other stops are geocoded', async () => {
    await insertFixtureFootprint(q, OMAHA_CORE);
    const { propertyId, customerId } = await insertFixtureProperty(q, companyA(), OMAHA_CORE, { withCustomer: true });
    await insertFixtureFootprint(q, [-95.94, 41.23]);

    const outcome = await run([repA()], 1500);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, unknown>).doors).toBe(2);

    const [prop] = await q('select address_line, city, state, zip from properties where id = $1', [propertyId]);
    const saved = `${prop!.address_line}, ${prop!.city}, ${prop!.state} ${prop!.zip}`;
    const stops = await stopRows();
    expect(stops).toHaveLength(2);
    const mine = stops.find((s) => s.property_id === propertyId);
    expect(mine?.address).toBe(saved);
    const other = stops.find((s) => s.property_id === null);
    expect(other?.address).toMatch(/^\d+ Fake St, Omaha, NE 68102$/);

    const [customer] = await q('select display_name from customers where id = $1', [customerId]);
    for (const s of stops) expect(String(s.address)).not.toContain(String(customer!.display_name));
  });

  test('skips excluded homes and do-not-contact customers', async () => {
    const a = await insertFixtureFootprint(q, [-95.94, 41.23]);
    const b = await insertFixtureFootprint(q, OMAHA_CORE);
    const c = await insertFixtureFootprint(q, [-95.95, 41.27]);
    await q(`insert into door_exclusions (company_id, footprint_id) values ($1, $2)`, [companyA(), a]);
    const { customerId } = await insertFixtureProperty(q, companyA(), OMAHA_CORE, { withCustomer: true });
    await q('update customers set do_not_contact = true where id = $1', [customerId]);

    const outcome = await run([repA()], 1500);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, unknown>).doors).toBe(1);
    const stops = await stopRows();
    expect(stops.map((s) => Number(s.footprint_id))).toEqual([c]);
    expect(stops.map((s) => Number(s.footprint_id))).not.toContain(b);
  });

  test('a re-run returns the same routes and writes nothing new', async () => {
    await insertGrid(10, 10);
    const first = await run([repA(), otherRepA()], 1500);
    expect(first.status).toBe('done');
    const routesBefore = await routeRows();
    const stopsBefore = await stopRows();

    const second = await run([repA(), otherRepA()], 1500);
    expect(second).toEqual(first);
    expect(await routeRows()).toEqual(routesBefore);
    expect(await stopRows()).toEqual(stopsBefore);
  });

  test('reverse geocoding goes out in chunks of at most 1000', async () => {
    await insertGrid(40, 30);
    const outcome = await run([repA(), otherRepA()], 1500);
    expect(outcome.status).toBe('done');
    expect((outcome.result as Record<string, unknown>).doors).toBe(1200);

    const reverse = t.geocoder.calls.filter((c) => c.method === 'reverseMany');
    expect(reverse).toHaveLength(2);
    const sizes = reverse.map((c) => (c.args[0] as unknown[]).length);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(1000);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(1200);
  });

  test('names routes with the city, the number and the rep', async () => {
    await q(`update users set name = 'Sam Rep' where id = $1`, [repA()]);
    await insertGrid(20, 16);

    const outcome = await run([repA()], 1500);
    expect(outcome.status).toBe('done');
    const names = (await routeRows()).map((r) => String(r.name));
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) expect(name).toMatch(/^Omaha · Route \d+ \(Sam\)$/);
    expect(names).toContain('Omaha · Route 1 (Sam)');
  });

  test('a stop with no address after geocoding shows Near lat, lng', async () => {
    t.geocoder.reverseMany = async (pts: unknown[]) => pts.map(() => null);
    await insertFixtureFootprint(q, [-95.9345, 41.2565]);

    const outcome = await run([repA()], 1500);
    expect(outcome.status).toBe('done');
    const stops = await stopRows();
    expect(stops).toHaveLength(1);
    expect(stops[0]!.address).toBe('Near 41.2565, -95.9345');
  });

  test('does nothing for a storm with no homes in the path', async () => {
    const outcome = await run([repA()], 1500);
    expect(outcome.status).toBe('done');
    expect(outcome.result).toEqual({ routes: 0, doors: 0, byRep: [] });
    expect(await routeRows()).toEqual([]);
  });

  test('an unreadable payload needs attention', async () => {
    const step = await stepFor({ companyStormId, repUserIds: [repA()], maxDoors: 10 });
    const outcome = await buildRoutesHandler(t.deps, agentCtx(companyA()), { ...step, payload: {} });
    expect(outcome.status).toBe('needs_attention');
  });
});
