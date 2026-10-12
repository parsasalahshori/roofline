import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';

/*
 * Door outcomes (S1 Task 15) against a real database: a rep records what happened at each door, and a
 * "wants a check" door becomes a customer, a home and a Lead job. These tests need Docker and run on CI only.
 */

const NOW = new Date('2026-10-12T15:00:00Z');
const NOT_FOUND = "We couldn't find that.";
const NOT_YOUR_ROUTE = 'This route belongs to someone else.';
const LEAD_REQUIRED = 'Please add the homeowner details.';
const PHONE_TAKEN = 'Another customer already has this number.';
const ADDRESS = '123 Main St, Omaha, NE 68102';
const LEAD = { name: 'Pat Home', phoneE164: '+14025550123', okToText: true, note: 'Hail on the back slope' };

let owner: pg.Pool;
let t: TestApp;
let stormId: string;
let routeId: string;
let stopIds: string[];
let footprintIds: number[];

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

const companyA = () => t.seed.a.companyId;
const repA = () => t.seed.a.rep.userId;

/** A route for `userId` in company A with `count` stops, each on its own footprint. */
async function seedRoute(userId: string, count: number): Promise<{ routeId: string; stopIds: string[]; footprintIds: number[] }> {
  const [cs] = await q(`select id from company_storms where company_id = $1`, [companyA()]);
  const [route] = await q(
    `insert into door_routes (company_id, company_storm_id, user_id, name, status, stops)
     values ($1, $2, $3, 'Route 1', 'ready', $4) returning id`,
    [companyA(), cs!.id, userId, count],
  );
  const stops: string[] = [];
  const prints: number[] = [];
  for (let i = 0; i < count; i++) {
    const [fp] = await q(
      `insert into building_footprints (state, geom, area_sq_ft, source, source_ref)
       values ('NE', ST_MakeEnvelope($1, 41.2, $2, 41.2001, 4326), 1000, 'fixture', $3) returning id`,
      [-95.97 + i * 0.001, -95.9699 + i * 0.001, `door-${userId}-${i}-${Math.random()}`],
    );
    const [stop] = await q(
      `insert into door_stops (company_id, route_id, position, footprint_id, point, address)
       values ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint(-95.97, 41.2), 4326), $5) returning id`,
      [companyA(), route!.id, i + 1, fp!.id, ADDRESS],
    );
    stops.push(stop!.id as string);
    prints.push(Number(fp!.id));
  }
  return { routeId: route!.id as string, stopIds: stops, footprintIds: prints };
}

beforeEach(async () => {
  t = await makeTestApp();
  t.clock.set(NOW);
  await q('delete from building_footprints');
  stormId = await insertOmahaStorm(q, '2026-10-11');
  await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit)
     values ($1, $2, 1.5, 0, 0)`,
    [companyA(), stormId],
  );
  ({ routeId, stopIds, footprintIds } = await seedRoute(repA(), 3));
});

const url = (i: number) => `/api/routes/${routeId}/stops/${stopIds[i]}/outcome`;
const stopRow = async (i: number) =>
  (await q(`select * from door_stops where id = $1`, [stopIds[i]]))[0]!;
const count = async (table: 'customers' | 'jobs') =>
  Number((await q(`select count(*)::int as n from ${table} where company_id = $1`, [companyA()]))[0]!.n);

describe('door outcomes', () => {
  test('each outcome is recorded once with who and when', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const outcomes = ['not_home', 'not_interested', 'has_roofer'] as const;
    for (const [i, outcome] of outcomes.entries()) {
      const res = await rep.post(url(i)).send({ outcome });
      expect(res.status).toBe(200);
      expect(res.body.stop.outcome).toBe(outcome);
      expect(res.body.stop.outcomeBy).toBe(repA());
      expect(new Date(res.body.stop.outcomeAt).getTime()).toBe(NOW.getTime());
      const row = await stopRow(i);
      expect(row.outcome).toBe(outcome);
      expect(row.outcome_by).toBe(repA());
      expect(new Date(row.outcome_at as string).getTime()).toBe(NOW.getTime());
    }
    expect(await count('customers')).toBe(0);
    expect(await count('jobs')).toBe(0);

    t.clock.set(new Date('2026-10-12T16:00:00Z'));
    const again = await rep.post(url(0)).send({ outcome: 'has_roofer' });
    expect(again.status).toBe(200);
    expect(again.body.stop.outcome).toBe('not_home');
    expect((await stopRow(0)).outcome).toBe('not_home');
    expect(new Date((await stopRow(0)).outcome_at as string).getTime()).toBe(NOW.getTime());
  });

  test('do_not_knock excludes the building', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.post(url(0)).send({ outcome: 'do_not_knock' });
    expect(res.status).toBe(200);
    const rows = await q(`select footprint_id from door_exclusions where company_id = $1`, [companyA()]);
    expect(rows.map((r) => Number(r.footprint_id))).toEqual([footprintIds[0]]);
  });

  test('wants_check creates customer, home and a Lead job', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.post(url(0)).send({ outcome: 'wants_check', lead: LEAD });
    expect(res.status).toBe(200);
    expect(res.body.createdJobId).toBeTruthy();
    expect(res.body.stop.createdJobId).toBe(res.body.createdJobId);

    const [job] = await q(`select * from jobs where id = $1`, [res.body.createdJobId]);
    expect(job!.stage).toBe('lead');
    expect(job!.source).toBe('storm');
    expect(job!.storm_id).toBe(stormId);
    expect(job!.assigned_user_id).toBe(repA());
    expect(job!.next_step).not.toBeNull();
    expect(job!.next_step_on).not.toBeNull();

    const stop = await stopRow(0);
    expect(stop.created_customer_id).toBeTruthy();
    expect(stop.created_job_id).toBe(res.body.createdJobId);
    const [customer] = await q(`select * from customers where id = $1`, [stop.created_customer_id]);
    expect(customer!.sms_consent_status).toBe('express');
    expect(customer!.sms_consent_source).toBe('door');
    expect(Object.keys(customer!.sms_consent_evidence as object).sort()).toEqual(['at', 'by', 'text']);
  });

  test('consent only when the box is ticked', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.post(url(0)).send({ outcome: 'wants_check', lead: { ...LEAD, okToText: false } });
    expect(res.status).toBe(200);
    const stop = await stopRow(0);
    const [customer] = await q(`select * from customers where id = $1`, [stop.created_customer_id]);
    expect(customer!.sms_consent_status).toBe('none');
    expect(customer!.sms_consent_source).toBeNull();
  });

  test('lead creation is idempotent per stop', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const first = await rep.post(url(0)).send({ outcome: 'wants_check', lead: LEAD });
    const second = await rep.post(url(0)).send({ outcome: 'wants_check', lead: LEAD });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.createdJobId).toBe(first.body.createdJobId);
    expect(await count('customers')).toBe(1);
    expect(await count('jobs')).toBe(1);
  });

  test('wants_check with a number another customer has is 409', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const first = await rep.post(url(0)).send({ outcome: 'wants_check', lead: LEAD });
    expect(first.status).toBe(200);
    const second = await rep.post(url(1)).send({ outcome: 'wants_check', lead: { ...LEAD, name: 'Sam Other' } });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: PHONE_TAKEN, field: 'lead.phoneE164' });
    expect((await stopRow(1)).outcome).toBeNull();
    expect(await count('customers')).toBe(1);
    expect(await count('jobs')).toBe(1);
  });

  test('wants_check without lead is 400', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.post(url(0)).send({ outcome: 'wants_check' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: LEAD_REQUIRED, field: 'lead' });
    expect((await stopRow(0)).outcome).toBeNull();
    expect(await count('customers')).toBe(0);
    expect(await count('jobs')).toBe(0);
  });

  test("a rep cannot record on another rep's route", async () => {
    const other = await loginAs(t.app, t.seed.a.otherRep);
    const denied = await other.post(url(0)).send({ outcome: 'not_home' });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe(NOT_YOUR_ROUTE);
    expect((await stopRow(0)).outcome).toBeNull();

    const boss = await loginAs(t.app, t.seed.a.owner);
    const ok = await boss.post(url(0)).send({ outcome: 'not_home' });
    expect(ok.status).toBe(200);
    expect(ok.body.stop.outcome).toBe('not_home');
  });

  test('cross-tenant is 404', async () => {
    const other = await loginAs(t.app, t.seed.b.owner);
    const post = await other.post(url(0)).send({ outcome: 'not_home' });
    expect(post.status).toBe(404);
    expect(post.body.error).toBe(NOT_FOUND);
    expect((await stopRow(0)).outcome).toBeNull();
    const get = await other.get(`/api/routes/${routeId}`);
    expect(get.status).toBe(404);
  });

  test('GET /api/routes/mine lists only my routes', async () => {
    const second = await seedRoute(t.seed.a.otherRep.userId, 2);
    const rep = await loginAs(t.app, t.seed.a.rep);
    const res = await rep.get('/api/routes/mine');
    expect(res.status).toBe(200);
    expect(res.body.routes.map((r: { id: string }) => r.id)).toEqual([routeId]);
    expect(res.body.routes[0]).toMatchObject({ userId: repA(), stops: 3, doneStops: 0, status: 'ready' });
    const other = await loginAs(t.app, t.seed.a.otherRep);
    const theirs = await other.get('/api/routes/mine');
    expect(theirs.body.routes.map((r: { id: string }) => r.id)).toEqual([second.routeId]);
  });

  test('GET /api/routes/:id is 404 for another rep and 200 for the assignee, owner and office', async () => {
    const other = await loginAs(t.app, t.seed.a.otherRep);
    expect((await other.get(`/api/routes/${routeId}`)).status).toBe(404);
    expect((await other.get('/api/routes/not-a-uuid')).status).toBe(404);

    for (const user of [t.seed.a.rep, t.seed.a.owner, t.seed.a.office]) {
      const agent = await loginAs(t.app, user);
      const res = await agent.get(`/api/routes/${routeId}`);
      expect(res.status).toBe(200);
      expect(res.body.route.id).toBe(routeId);
      expect(res.body.stops).toHaveLength(3);
      expect(res.body.stops.map((s: { position: number }) => s.position)).toEqual([1, 2, 3]);
      const keys = Object.keys(res.body.stops[0]);
      expect(keys).not.toContain('ownerName');
      expect(keys).not.toContain('customerName');
      expect(res.body.stops[0].address).toBe(ADDRESS);
    }
  });

  test('route moves to in_progress then done', async () => {
    const rep = await loginAs(t.app, t.seed.a.rep);
    const status = async () =>
      (await q(`select status from door_routes where id = $1`, [routeId]))[0]!.status;
    expect(await status()).toBe('ready');
    await rep.post(url(0)).send({ outcome: 'not_home' });
    expect(await status()).toBe('in_progress');
    await rep.post(url(1)).send({ outcome: 'not_interested' });
    expect(await status()).toBe('in_progress');
    await rep.post(url(2)).send({ outcome: 'has_roofer' });
    expect(await status()).toBe('done');
  });
});
