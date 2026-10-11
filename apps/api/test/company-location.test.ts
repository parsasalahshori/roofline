import { beforeEach, describe, expect, test } from 'vitest';
import { dbAudit } from './crm-helpers.ts';
import { loginAs, makeTestApp, type SuperAgent, type TestApp } from './helpers.ts';

const NOT_ON_MAP = 'Place your address on the map first.';
const PICK_MILES = 'Pick 10, 20, 40 or 60 miles.';
const SQUARE_METERS_20_MILES = Math.PI * 32186.88 ** 2;

let t: TestApp;
let owner: SuperAgent;

beforeEach(async () => {
  t = await makeTestApp();
  owner = await loginAs(t.app, t.seed.a.owner);
  // The seeded companies have no address yet; the owner types one in first.
  const res = await owner
    .patch('/api/company')
    .send({ addressStreet: '1200 Farnam St', addressCity: 'Omaha', addressState: 'NE', addressZip: '68102' });
  expect(res.status).toBe(200);
});

/** A read-only look at the company row through the system pool's raw client. */
async function companyRow(companyId: string) {
  const result = await t.deps.pools.system.$client.query(
    `select (location is not null) as located,
            ST_Area(service_area::geography) as area,
            service_area_miles
       from companies where id = $1`,
    [companyId],
  );
  return result.rows[0] as { located: boolean; area: number | null; service_area_miles: number | null };
}

describe('POST /api/company/locate', () => {
  test('locate as owner returns 200 located true', async () => {
    const res = await owner.post('/api/company/locate');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ located: true });
    expect((await companyRow(t.seed.a.companyId)).located).toBe(true);
  });

  test('locate as office is 403', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    const res = await office.post('/api/company/locate');
    expect(res.status).toBe(403);
    expect((await companyRow(t.seed.a.companyId)).located).toBe(false);
  });

  test('locate writes an audit row', async () => {
    expect((await owner.post('/api/company/locate')).status).toBe(200);
    const rows = await dbAudit(t, t.seed.a.companyId, 'company.located');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ targetType: 'company', targetId: t.seed.a.companyId, after: { located: true } });
  });
});

describe('PUT /api/company/service-area', () => {
  test('radius 20 builds a 20 mile area', async () => {
    expect((await owner.post('/api/company/locate')).status).toBe(200);
    const res = await owner.put('/api/company/service-area').send({ radiusMiles: 20 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ located: true, serviceAreaMiles: 20 });

    const row = await companyRow(t.seed.a.companyId);
    expect(row.service_area_miles).toBe(20);
    expect(Math.abs(Number(row.area) / SQUARE_METERS_20_MILES - 1)).toBeLessThan(0.02);
  });

  test('radius 25 is a field error', async () => {
    const res = await owner.put('/api/company/service-area').send({ radiusMiles: 25 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PICK_MILES, field: 'radiusMiles' });
  });

  test('a radius sent as text is a field error too', async () => {
    const res = await owner.put('/api/company/service-area').send({ radiusMiles: '20' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: PICK_MILES, field: 'radiusMiles' });
  });

  test('a company that is not on the map yet gets 409', async () => {
    expect((await owner.post('/api/company/locate')).status).toBe(200);
    await t.deps.pools.system.$client.query('update companies set location = null, service_area = null where id = $1', [
      t.seed.a.companyId,
    ]);
    const res = await owner.put('/api/company/service-area').send({ radiusMiles: 20 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: NOT_ON_MAP });
  });

  test('a radius change writes an audit row with the old and new radius', async () => {
    expect((await owner.post('/api/company/locate')).status).toBe(200);
    expect((await owner.put('/api/company/service-area').send({ radiusMiles: 20 })).status).toBe(200);
    const rows = await dbAudit(t, t.seed.a.companyId, 'company.service_area');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: { radiusMiles: 40 }, after: { radiusMiles: 20 } });
  });

  test('an office user is refused', async () => {
    const office = await loginAs(t.app, t.seed.a.office);
    expect((await office.put('/api/company/service-area').send({ radiusMiles: 20 })).status).toBe(403);
  });
});

describe('GET /api/company', () => {
  test('GET /api/company shows located and the radius', async () => {
    expect((await owner.post('/api/company/locate')).status).toBe(200);
    expect((await owner.put('/api/company/service-area').send({ radiusMiles: 20 })).status).toBe(200);
    const res = await owner.get('/api/company');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ located: true, serviceAreaMiles: 20 });
  });

  test('a company not yet on the map shows located false', async () => {
    const res = await owner.get('/api/company');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ located: false, serviceAreaMiles: null });
  });
});
