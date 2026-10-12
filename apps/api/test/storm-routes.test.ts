import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, test } from 'vitest';
import { insertOmahaStorm, type Query } from '@roofline/db/testing';
import { Actors } from './crm-helpers.ts';
import { makeTestApp, type TestApp } from './helpers.ts';
import { NO_UUID } from './crm-helpers.ts';

/*
 * The storms API (S1 Task 21): list, detail, dismiss and redraft. Storms are inserted through the owner
 * connection. These tests need Docker and run on CI only.
 */

const NOT_ALLOWED = "Your role can't do that. Ask the owner.";
const NOT_FOUND = "We couldn't find that.";
const RESULT_KEYS = [
  'adClicks',
  'adMaxCents',
  'adSpendCents',
  'doorsKnocked',
  'emailsSent',
  'inspectionsBooked',
  'landingRequests',
  'replies',
  'textsDelivered',
  'textsSent',
  'unsubscribes',
  'wantsCheck',
  'yesReplies',
];

let owner: pg.Pool;
let t: TestApp;
let who: Actors;

const q: Query = async (text, values) => (await owner.query(text, values)).rows;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject('dbUrls').owner });
});
afterAll(async () => {
  await owner.end();
});

beforeEach(async () => {
  t = await makeTestApp();
  who = new Actors(t);
  await q(
    `update companies set address_street = '1200 Farnam St', address_city = 'Omaha', address_state = 'NE', address_zip = '68102' where id = $1`,
    [t.seed.a.companyId],
  );
});

/** A global storm and the company's row for it. */
async function addStorm(day: string, place: string, companyKey: 'a' | 'b' = 'a', maxIn = 1.5): Promise<string> {
  const stormId = await insertOmahaStorm(q, day);
  await q(`update storms set place_name = $2 where id = $1`, [stormId, place]);
  const rows = await q(
    `insert into company_storms (company_id, storm_id, max_in, customers_hit, homes_hit) values ($1, $2, $3, 3, 10) returning id`,
    [t.seed[companyKey].companyId, stormId, maxIn],
  );
  return rows[0]!.id as string;
}

describe('GET /api/storms', () => {
  test('needs a session', async () => {
    expect((await (await import('supertest')).default(t.app).get('/api/storms')).status).toBe(401);
  });

  test('lists the company storms newest first, without dismissed ones, with maxIn as a number', async () => {
    const older = await addStorm('2026-10-08', 'Older, NE');
    const newer = await addStorm('2026-10-11', 'Newer, NE', 'a', 1.75);
    const gone = await addStorm('2026-10-10', 'Gone, NE');
    await addStorm('2026-10-09', 'Other company, NE', 'b');
    await q(`update company_storms set status = 'dismissed' where id = $1`, [gone]);

    const res = await (await who.as('owner')).get('/api/storms');
    expect(res.status).toBe(200);
    expect(res.body.storms.map((s: { id: string }) => s.id)).toEqual([newer, older]);
    expect(res.body.storms[0]).toEqual({
      id: newer,
      placeName: 'Newer, NE',
      day: '2026-10-11',
      maxIn: 1.75,
      status: 'provisional',
      customersHit: 3,
      homesHit: 10,
      planTaskId: null,
      planStatus: null,
    });
    expect(typeof res.body.storms[0].maxIn).toBe('number');
  });

  test('a rep may read the list', async () => {
    await addStorm('2026-10-11', 'Omaha, NE');
    const res = await (await who.as('rep')).get('/api/storms');
    expect(res.status).toBe(200);
    expect(res.body.storms).toHaveLength(1);
  });
});

describe('GET /api/storms/:id', () => {
  test('returns the storm, its swath, the 13 results and no plan', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const res = await (await who.as('owner')).get(`/api/storms/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.storm).toMatchObject({ id, placeName: 'Omaha, NE', day: '2026-10-11', maxIn: 1.5 });
    expect(res.body.swath.type).toBe('FeatureCollection');
    expect(res.body.swath.features.length).toBeGreaterThan(0);
    for (const f of res.body.swath.features) {
      expect(f.type).toBe('Feature');
      expect(f.geometry.type).toMatch(/Polygon/);
      expect(typeof f.properties.thresholdIn).toBe('number');
      expect(f.properties.thresholdIn).toBeGreaterThanOrEqual(0.75);
    }
    expect(Object.keys(res.body.results).sort()).toEqual(RESULT_KEYS);
    expect(Object.values(res.body.results).every((v) => v === 0)).toBe(true);
    expect(res.body.plan).toBeNull();
  });

  test('a rep may read it', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    expect((await (await who.as('rep')).get(`/api/storms/${id}`)).status).toBe(200);
  });

  test('another company, an unknown id and a bad id are all 404', async () => {
    const other = await addStorm('2026-10-11', 'Omaha, NE', 'b');
    const owner_ = await who.as('owner');
    for (const id of [other, NO_UUID, 'not-a-uuid']) {
      const res = await owner_.get(`/api/storms/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe(NOT_FOUND);
    }
  });

  test('/layer is not captured by /:id', async () => {
    const res = await (await who.as('owner')).get('/api/storms/layer').query({ bbox: '-96.2,41.1,-95.8,41.4' });
    expect(res.status).toBe(200);
    expect(res.body.swaths.type).toBe('FeatureCollection');
  });
});

describe('POST /api/storms/:id/dismiss', () => {
  test('the owner dismisses it and the list omits it', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const owner_ = await who.as('owner');
    const res = await owner_.post(`/api/storms/${id}/dismiss`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect((await owner_.get('/api/storms')).body.storms).toEqual([]);
    const audits = await q(`select 1 from audit_log where action = 'storm.dismiss' and target_id = $1`, [id]);
    expect(audits).toHaveLength(1);
  });

  test('a rep gets 403', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const res = await (await who.as('rep')).post(`/api/storms/${id}/dismiss`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(NOT_ALLOWED);
  });

  test('another company storm is a 404', async () => {
    const other = await addStorm('2026-10-11', 'Omaha, NE', 'b');
    const res = await (await who.as('owner')).post(`/api/storms/${other}/dismiss`).send({});
    expect(res.status).toBe(404);
    const rows = await q(`select status from company_storms where id = $1`, [other]);
    expect(rows[0]!.status).toBe('new');
  });
});

describe('POST /api/storms/:id/plan', () => {
  test('drafts a plan for a storm with none', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const owner_ = await who.as('owner');
    const res = await owner_.post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(200);
    expect(typeof res.body.taskId).toBe('string');
    const detail = await owner_.get(`/api/storms/${id}`);
    expect(detail.body.plan).toEqual({ taskId: res.body.taskId, status: 'draft' });
    expect(detail.body.storm.planTaskId).toBe(res.body.taskId);
  });

  test('a draft plan is drafted again with a new task', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const owner_ = await who.as('owner');
    const first = await owner_.post(`/api/storms/${id}/plan`).send({});
    const res = await owner_.post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(200);
    expect(res.body.taskId).not.toBe(first.body.taskId);
    const detail = await owner_.get(`/api/storms/${id}`);
    expect(detail.body.plan).toEqual({ taskId: res.body.taskId, status: 'draft' });
  });

  test('a storm whose plan is no longer a draft is a 409', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    const owner_ = await who.as('owner');
    const first = await owner_.post(`/api/storms/${id}/plan`).send({});
    await q("update tasks set status = 'approved' where id = $1", [first.body.taskId]);
    const res = await owner_.post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(409);
    const detail = await owner_.get(`/api/storms/${id}`);
    expect(detail.body.plan.taskId).toBe(first.body.taskId);
  });

  test('a dismissed storm is a 409', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    await q(`update company_storms set status = 'dismissed' where id = $1`, [id]);
    const res = await (await who.as('owner')).post(`/api/storms/${id}/plan`).send({});
    expect(res.status).toBe(409);
  });

  test('a rep gets 403', async () => {
    const id = await addStorm('2026-10-11', 'Omaha, NE');
    expect((await (await who.as('rep')).post(`/api/storms/${id}/plan`).send({})).status).toBe(403);
  });

  test('another company storm is a 404', async () => {
    const other = await addStorm('2026-10-11', 'Omaha, NE', 'b');
    expect((await (await who.as('owner')).post(`/api/storms/${other}/plan`).send({})).status).toBe(404);
  });
});
